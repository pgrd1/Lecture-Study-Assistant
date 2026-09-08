import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { CompatibilityLectureProcessor } from '../application/content/compatibilityLectureProcessor';
import { EvidencePipelineProcessor } from '../application/content/evidencePipelineProcessor';
import { contentError } from '../application/content/pipelineOperations';
import { CourseWorkspaceService } from '../application/obsidian/courseWorkspaceService';
import {
  type InboxAnswerInput,
  QuestionInboxService,
} from '../application/obsidian/questionInboxService';
import { assertNoInstructionEcho } from '../application/prompts/instructionEchoGuard';
import { PromptComposer } from '../application/prompts/promptComposer';
import { PromptProfileService } from '../application/prompts/promptProfileService';
import type { AiProviderRouter } from '../application/providers/aiProviderRouter';
import { assertNoReparsePoints } from '../core/paths/safePath';
import type { ProviderOperation } from '../core/ports/aiProvider';
import type { ProcessorInput } from '../core/ports/processor';
import type { SourceMetadataPort } from '../core/ports/sourceMetadata';
import type { StudyContentInput } from '../core/ports/studyContentProcessor';
import type { SqliteRepositories } from '../infrastructure/db/sqliteDatabase';
import { createJsonPipelineArtifactStore } from '../infrastructure/filesystem/jsonPipelineArtifactStore';
import { LocalSourceMetadata } from '../infrastructure/metadata/localSourceMetadata';
import { VaultService } from '../infrastructure/vault/vaultService';
import { VaultWriter } from '../infrastructure/vault/vaultWriter';
import { assertBoundedPipelineJson } from '../shared/contracts/boundedPipelineJson';
import type { PromptProfile } from '../shared/contracts/promptProfile';
import { AI_FEATURES, type JsonValue } from '../shared/contracts/provider';
import { QuestionAnswerSchema } from '../shared/contracts/questionInbox';
import type { AppSettings } from '../shared/contracts/settings';
import { VerifiedStudyContentSchema } from '../shared/contracts/studyContent';
import { APP_ERROR_MESSAGES, AppError } from '../shared/errors';

type Dependencies = Readonly<{
  repositories: SqliteRepositories;
  userDataRoot: string;
  artifactRoot: string;
  providerRuntime: Readonly<{ router: Pick<AiProviderRouter, 'execute' | 'shutdown'> }>;
  metadata?: SourceMetadataPort;
}>;
const contained = (root: string, path: string): boolean => {
  const child = relative(root, path);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
};

export const createContentPipelineRuntime = async (dependencies: Dependencies) => {
  const { repositories, userDataRoot, artifactRoot } = dependencies;
  const validateStorageRoots = (
    proposed: Pick<AppSettings, 'vaultPath' | 'icloudQueuePath'>,
  ): void => {
    for (const sourceRoot of [proposed.vaultPath, proposed.icloudQueuePath]) {
      if (sourceRoot === null) continue;
      if (
        !isAbsolute(sourceRoot) ||
        contained(sourceRoot, userDataRoot) ||
        contained(userDataRoot, sourceRoot)
      )
        throw contentError('PROVIDER_UNSAFE_VERSION');
      assertNoReparsePoints(sourceRoot);
    }
  };
  const assertRoots = () => {
    if (
      !isAbsolute(userDataRoot) ||
      !isAbsolute(artifactRoot) ||
      resolve(userDataRoot) === resolve(artifactRoot) ||
      !contained(userDataRoot, artifactRoot)
    )
      throw contentError('PROVIDER_UNSAFE_VERSION');
    assertNoReparsePoints(userDataRoot);
    assertNoReparsePoints(artifactRoot);
    const settings = repositories.settings.get();
    validateStorageRoots({
      vaultPath: settings?.vaultPath ?? null,
      icloudQueuePath: settings?.icloudQueuePath ?? null,
    });
  };
  assertRoots();
  const userStats = await lstat(userDataRoot);
  if (
    !userStats.isDirectory() ||
    userStats.isSymbolicLink() ||
    resolve(await realpath(userDataRoot)).toLowerCase() !== resolve(userDataRoot).toLowerCase()
  )
    throw contentError('PROVIDER_UNSAFE_VERSION');
  const artifacts = await createJsonPipelineArtifactStore(
    artifactRoot,
    repositories.pipelineArtifacts,
  );
  assertRoots();
  const promptProfiles = new PromptProfileService(repositories.promptProfiles);
  const providerRouter = dependencies.providerRuntime.router;
  const lifetime = new AbortController();
  const active = new Set<Promise<unknown>>();
  const track = <T>(run: () => Promise<T>): Promise<T> => {
    if (lifetime.signal.aborted) return Promise.reject(contentError('PROVIDER_CANCELLED'));
    try {
      const work = run();
      active.add(work);
      void work.then(
        () => active.delete(work),
        () => active.delete(work),
      );
      return work;
    } catch (error) {
      return Promise.reject(error);
    }
  };
  let shutdownPromise: Promise<void> | undefined;
  let workspace:
    | Readonly<{ path: string; service: CourseWorkspaceService; inbox: QuestionInboxService }>
    | undefined;
  const currentWorkspace = async () => {
    assertRoots();
    const path = repositories.settings.get()?.vaultPath ?? null;
    if (path === null) {
      workspace = undefined;
      return null;
    }
    if (workspace?.path === path) return workspace.service;
    const connection = await new VaultService().connect({ path, mode: 'existing' });
    if (repositories.settings.get()?.vaultPath !== path)
      throw new AppError('VAULT_WRITE_FAILED', APP_ERROR_MESSAGES.VAULT_WRITE_FAILED);
    const writer = new VaultWriter(connection);
    const service = new CourseWorkspaceService({
      repositories,
      artifactRoot,
      connection,
      writer,
    });
    const inbox = new QuestionInboxService({
      workspaceRoot: connection.realManagedRoot,
      writer,
      revisions: repositories.managedNotes,
      targets: () => service.questionInboxTargets(),
      evidence: (target) => service.questionEvidence(target.courseId),
      answer: answerQuestion,
      assertCurrent: () => {
        assertRoots();
        if (
          repositories.settings.get()?.vaultPath !== path ||
          repositories.settings.get()?.processingPaused ||
          lifetime.signal.aborted
        )
          throw contentError('PROVIDER_CANCELLED');
      },
    });
    workspace = Object.freeze({ path, service, inbox });
    return service;
  };
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= new Promise<void>((resolveDrain, rejectDrain) => {
      lifetime.abort();
      const timer = setTimeout(() => rejectDrain(contentError('PROVIDER_CANCELLED')), 15_000);
      const drain = async () => {
        await providerRouter.shutdown();
        await Promise.allSettled([...active]);
        workspace = undefined;
      };
      void drain()
        .then(resolveDrain, () => rejectDrain(contentError('PROVIDER_CANCELLED')))
        .finally(() => clearTimeout(timer));
    }).catch((error: unknown) => {
      shutdownPromise = undefined;
      throw error;
    });
    return shutdownPromise;
  };
  const router = Object.freeze({
    execute: <T extends JsonValue>(request: ProviderOperation<T>) =>
      track(() =>
        providerRouter.execute({
          ...request,
          signal: AbortSignal.any([request.signal, lifetime.signal]),
        }),
      ),
    shutdown,
  });
  const answerQuestion = async (input: InboxAnswerInput) => {
    const route = repositories.providerRoutes.get('course_question_answer');
    if (!route) throw contentError('PROVIDER_NOT_CONFIGURED');
    const composition = promptProfiles.compose({
      feature: 'course_question_answer',
      courseId: input.target.courseId,
      courseInstructions: input.target.userInstructions,
      sourceBlocks: [
        {
          role: 'user',
          kind: 'source',
          text: JSON.stringify({ question: input.question, evidence: input.evidence }),
        },
      ],
    });
    const requestId = randomUUID();
    const instructionTexts = [
      input.target.userInstructions,
      composition.effectiveTemplate,
      ...composition.layers.slice(2).map((layer) => layer.text),
      ...composition.blocks.flatMap((block) =>
        'text' in block && (block.kind === 'instruction' || block.role === 'system')
          ? [block.text]
          : [],
      ),
    ];
    const result = await router.execute({
      requestId,
      jobId: null,
      feature: 'course_question_answer',
      outputSchemaId: 'question_answer_v1',
      outputJsonSchema: z.toJSONSchema(QuestionAnswerSchema) as Readonly<Record<string, JsonValue>>,
      parseOutput: (value) => QuestionAnswerSchema.parse(value),
      blocks: composition.blocks,
      composedPromptSha256: composition.fingerprint,
      timeoutMs: 120_000,
      maxOutputTokens: 4096,
      signal: input.signal,
    });
    const answer = {
      output: result.output,
      provenance: {
        requestId,
        modelId: result.reportedModelId ?? route.modelId ?? 'unknown',
        promptVersion: route.promptVersion,
        promptSha256: composition.fingerprint,
        completedAt: result.completedAt,
      },
    };
    assertNoInstructionEcho(answer, instructionTexts);
    return answer;
  };
  const pollQuestionInboxes = () =>
    track(async () => {
      const settings = repositories.settings.get();
      if (!settings?.vaultPath || settings.processingPaused) {
        workspace = undefined;
        return;
      }
      await currentWorkspace();
      await workspace?.inbox.pollOnce(lifetime.signal);
    });
  class RuntimeProcessor extends EvidencePipelineProcessor {
    override processBundle(input: StudyContentInput) {
      return track(() => super.processBundle(input));
    }
  }
  class RuntimeCompatibilityProcessor extends CompatibilityLectureProcessor {
    override process(input: ProcessorInput) {
      return track(async () => {
        let service: CourseWorkspaceService | null;
        const selectedVault = repositories.settings.get()?.vaultPath ?? null;
        try {
          service = await currentWorkspace();
        } catch {
          throw new AppError('VAULT_WRITE_FAILED', APP_ERROR_MESSAGES.VAULT_WRITE_FAILED);
        }
        const boundary = new CompatibilityLectureProcessor({
          jobs: repositories.jobs,
          bundles: repositories.sourceBundles,
          existingTopics: async (courseId) => {
            try {
              return service ? await service.existingTopics(courseId, input.jobId) : [];
            } catch {
              throw new AppError('VAULT_WRITE_FAILED', APP_ERROR_MESSAGES.VAULT_WRITE_FAILED);
            }
          },
          processor: {
            processBundle: async (contentInput) => {
              const value = await processor.processBundle(contentInput);
              assertBoundedPipelineJson(value);
              const content = VerifiedStudyContentSchema.parse(value);
              if (service) {
                try {
                  assertRoots();
                  if (repositories.settings.get()?.vaultPath !== selectedVault)
                    throw new Error('WORKSPACE_CONFIGURATION_CHANGED');
                  const job = repositories.jobs.get(input.jobId);
                  const bundle = repositories.sourceBundles.getByJobId(input.jobId);
                  if (!job || !bundle) throw new Error('WORKSPACE_SOURCE_MISSING');
                  await service.publish({
                    course: repositories.courses.get(input.courseId),
                    job,
                    bundle,
                    sources: repositories.sourceBundles.listRecords(bundle.id),
                    content,
                    provenance: repositories.providerInvocations
                      .listForJob(input.jobId)
                      .filter((invocation) => invocation.status === 'completed')
                      .map((invocation) => ({
                        invocationId: invocation.id,
                        modelId: invocation.reportedModelId ?? invocation.selectedModelId,
                        promptVersion: invocation.promptVersion,
                      })),
                  });
                  if (repositories.settings.get()?.vaultPath !== selectedVault)
                    throw new Error('WORKSPACE_CONFIGURATION_CHANGED');
                } catch {
                  throw new AppError('VAULT_WRITE_FAILED', APP_ERROR_MESSAGES.VAULT_WRITE_FAILED);
                }
              } else if ((repositories.settings.get()?.vaultPath ?? null) !== selectedVault) {
                throw new AppError('VAULT_WRITE_FAILED', APP_ERROR_MESSAGES.VAULT_WRITE_FAILED);
              }
              return content;
            },
          },
        });
        return boundary.process(input);
      });
    }
  }
  const processor = new RuntimeProcessor({
    bundles: repositories.sourceBundles,
    routes: repositories.providerRoutes,
    jobs: repositories.jobs,
    checkpoints: repositories.pipelineArtifacts,
    artifacts,
    metadata: dependencies.metadata ?? new LocalSourceMetadata(),
    composer: new PromptComposer(),
    router,
    lifetimeSignal: lifetime.signal,
    assertAttemptCurrent: () => {
      if (lifetime.signal.aborted) throw contentError('PROVIDER_CANCELLED');
      assertRoots();
    },
    promptInputs: (courseId) => {
      const course = repositories.courses.get(courseId);
      if (!course) throw contentError();
      const global = promptProfiles.get({ scope: 'global', courseId: null, feature: null });
      const own = promptProfiles.get({ scope: 'course', courseId, feature: null });
      return Object.freeze(
        Object.fromEntries(
          AI_FEATURES.map((feature) => {
            const selected =
              promptProfiles.get({ scope: 'feature', courseId, feature }) ??
              promptProfiles.get({ scope: 'feature', courseId: null, feature });
            return [
              feature,
              Object.freeze({
                courseInstructions: course.userInstructions,
                profiles: Object.freeze(
                  [global, own, selected].filter((p): p is PromptProfile => p !== null),
                ),
              }),
            ];
          }),
        ),
      );
    },
  });
  const compatibilityProcessor = new RuntimeCompatibilityProcessor({
    processor,
    jobs: repositories.jobs,
    bundles: repositories.sourceBundles,
    // The runtime override binds durable topic context to each job attempt.
    existingTopics: () => Object.freeze([]),
  });
  return Object.freeze({
    processor,
    compatibilityProcessor,
    promptProfiles,
    pollQuestionInboxes,
    validateStorageRoots,
    router,
    shutdown,
  });
};
export type ContentPipelineRuntime = Awaited<ReturnType<typeof createContentPipelineRuntime>>;
