import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createProviderOperation } from '../../core/ports/aiProvider';
import type { JobRepository } from '../../core/ports/jobRepository';
import type { PipelineArtifactRepository } from '../../core/ports/pipelineArtifactRepository';
import type { StudyContentInput } from '../../core/ports/studyContentProcessor';
import { sha256CanonicalJson } from '../../core/providers/canonicalJson';
import { JobSchema } from '../../shared/contracts/job';
import {
  assertBoundedPipelineJson,
  type PipelineArtifact,
  type PipelineArtifactIdentity,
  PipelineArtifactWriteSchema,
  type PipelineBundleReceipt,
  type StudyStageIdentity,
  StudyStageIdentitySchema,
} from '../../shared/contracts/pipelineArtifact';
import {
  type AiFeature,
  type JsonValue,
  ProviderRouteSchema,
} from '../../shared/contracts/provider';
import {
  type SourceBundle,
  SourceBundleSchema,
  type SourceRecord,
  SourceRecordSchema,
} from '../../shared/contracts/sourceBundle';
import {
  type ExistingTopicDescriptor,
  parseExistingTopics,
} from '../../shared/contracts/studyContent';
import {
  assertContentActive,
  type ContentPipelineDependencies,
  contentError,
  type ExtractionResult,
  type StageResult,
} from './pipelineOperations';

export type StudyPipelineDependencies = ContentPipelineDependencies &
  Readonly<{
    jobs: Pick<JobRepository, 'get'>;
    checkpoints: Pick<PipelineArtifactRepository, 'get'>;
  }>;
export type StudyStageResult<T> = Readonly<{
  artifact: PipelineArtifact;
  identity: StudyStageIdentity;
  value: T;
  bundleReceipt: PipelineBundleReceipt;
}>;
export type StudyUpstream = Readonly<{
  artifact: PipelineArtifact;
  identity: PipelineArtifactIdentity;
}>;
export type StudyStageInput = Readonly<{
  input: StudyContentInput;
  evidence: StageResult<ExtractionResult>;
  upstream: readonly StudyUpstream[];
  existingTopics: readonly ExistingTopicDescriptor[];
  sourceSnapshot: StudySourceSnapshot;
}>;
type StudySourceSnapshot = Readonly<{ bundle: SourceBundle; records: readonly SourceRecord[] }>;
type StageSpec<T> = Readonly<{
  stage: 'clustering' | 'synthesis' | 'verification';
  feature: AiFeature;
  schemaId: 'topic_clusters_v2' | 'study_content_v2' | 'study_verification_v1';
  schema: z.ZodType<T>;
  instructions: string;
  context: unknown;
  validate: (value: unknown) => T;
}>;

export const assertStudyJob = (
  deps: StudyPipelineDependencies,
  input: StudyContentInput,
): StudySourceSnapshot => {
  assertContentActive(input.signal);
  const job = JobSchema.parse(deps.jobs.get(z.uuid().parse(input.jobId)));
  const bundle = SourceBundleSchema.parse(deps.bundles.getByJobId(input.jobId));
  // Zod copies every record's scalar fields; freeze the array so no repository alias is retained.
  const records = z
    .array(SourceRecordSchema)
    .min(1)
    .max(32)
    .readonly()
    .parse(deps.bundles.listRecords(bundle.id));
  if (
    job.courseId !== input.courseId ||
    job.sourceBundleId !== input.sourceBundleId ||
    bundle.id !== input.sourceBundleId ||
    bundle.jobId !== job.id ||
    bundle.sourceCount !== job.sourceCount ||
    records.length !== bundle.sourceCount ||
    new Set(records.map((record) => record.id)).size !== records.length ||
    records.some((record, index) => record.bundleId !== bundle.id || record.ordinal !== index) ||
    records.reduce((total, record) => total + record.sizeBytes, 0) !== bundle.totalBytes
  )
    throw contentError();
  return Object.freeze({ bundle, records });
};

const routesFor = (
  identity: PipelineArtifactIdentity,
): readonly Readonly<{ feature: AiFeature }>[] =>
  'identityVersion' in identity
    ? 'operation' in identity
      ? [identity.operation.route]
      : identity.operations.map((op) => op.route)
    : [identity.route];

export const runStudyStage = async <T>(
  deps: StudyPipelineDependencies,
  stageInput: StudyStageInput,
  spec: StageSpec<T>,
): Promise<StudyStageResult<T>> => {
  const { input, evidence, upstream, existingTopics } = stageInput;
  assertStudyJob(deps, input);
  deps.assertAttemptCurrent?.();
  assertBoundedPipelineJson(spec.context);
  const source = {
    role: 'user' as const,
    kind: 'source' as const,
    text: JSON.stringify(spec.context),
  };
  const compose = () => {
    const editable = input.prompts?.[spec.feature];
    return deps.composer.compose({
      ...editable,
      feature: spec.feature,
      courseId: input.courseId,
      featureInstructions: `${spec.instructions}\n${editable?.featureInstructions ?? ''}`,
      sourceBlocks: [source, ...(input.contextBlocks ?? [])],
    });
  };
  const prompt = compose();
  const saved = deps.routes.get(spec.feature);
  if (!saved) throw contentError('PROVIDER_NOT_CONFIGURED');
  const route = ProviderRouteSchema.parse(saved);
  // ProviderRouteSchema owns API-model requirements; CLI default/null is valid.
  if (!route.enabled || route.providerId === null) throw contentError('PROVIDER_NOT_CONFIGURED');
  const identity = StudyStageIdentitySchema.parse({
    identityVersion: 5,
    operationVersion: 'study-stages-v2',
    contextSha256: sha256CanonicalJson(input.contextBlocks ?? []),
    sources: evidence.identity.sources,
    upstream: upstream.map((s) => ({ stage: s.artifact.stage, sha256: s.artifact.sha256 })),
    existingTopicContextSha256: sha256CanonicalJson(existingTopics),
    operation: {
      sourceIds: evidence.identity.sources.map((s) => s.sourceId),
      prompt: prompt.promptIdentity,
      route,
    },
  });
  const assertCurrent = () => {
    deps.assertAttemptCurrent?.();
    const sources = assertStudyJob(deps, input);
    if (sha256CanonicalJson(sources) !== sha256CanonicalJson(stageInput.sourceSnapshot))
      throw contentError();
    if (
      sha256CanonicalJson(parseExistingTopics(input.existingTopics, input.courseId)) !==
        identity.existingTopicContextSha256 ||
      compose().fingerprint !== prompt.fingerprint
    )
      throw contentError('PROVIDER_NOT_READY');
    for (const r of [route, ...upstream.flatMap((s) => routesFor(s.identity))])
      if (sha256CanonicalJson(deps.routes.get(r.feature)) !== sha256CanonicalJson(r))
        throw contentError('PROVIDER_NOT_READY');
    const { records } = sources;
    if (
      records.length !== identity.sources.length ||
      records.some(
        (r, i) =>
          r.bundleId !== input.sourceBundleId ||
          r.ordinal !== i ||
          r.id !== identity.sources[i]?.sourceId ||
          r.sha256 !== identity.sources[i]?.sha256,
      )
    )
      throw contentError();
    for (const snapshot of upstream) {
      const pointer = deps.checkpoints.get(input.jobId, snapshot.artifact.stage);
      if (
        pointer?.sha256 !== snapshot.artifact.sha256 ||
        pointer.identitySha256 !== snapshot.artifact.identitySha256
      )
        throw contentError();
    }
  };
  const guard = async () => {
    assertCurrent();
    for (const snapshot of upstream) {
      const current = await deps.artifacts.read(
        input.jobId,
        snapshot.artifact.stage,
        snapshot.identity,
        snapshot.artifact.schemaVersion,
      );
      if (current?.sha256 !== snapshot.artifact.sha256) throw contentError();
      assertCurrent();
    }
    assertCurrent();
  };
  const validate = (raw: unknown): T => {
    assertBoundedPipelineJson(raw);
    const value = spec.validate(spec.schema.parse(raw));
    assertBoundedPipelineJson(value);
    // Paths are never valid lecture content or provenance.
    if (/(?:[a-z]:[\\/]|file:\/\/|\\\\[^\\\s]+\\)/iu.test(JSON.stringify(value)))
      throw contentError();
    return value;
  };
  await guard();
  const cached = await deps.artifacts.read(input.jobId, spec.stage, identity, 1);
  await guard();
  if (cached !== null) {
    if (!('bundleReceipt' in cached)) throw contentError();
    if (deps.checkpoints.get(input.jobId, spec.stage)?.sha256 !== cached.sha256)
      throw contentError();
    return Object.freeze({
      artifact: cached,
      identity,
      value: validate(cached.value),
      bundleReceipt: cached.bundleReceipt,
    });
  }
  const operation = createProviderOperation({
    requestId: randomUUID(),
    feature: spec.feature,
    jobId: input.jobId,
    outputSchemaId: spec.schemaId,
    outputJsonSchema: JSON.parse(
      JSON.stringify(z.toJSONSchema(spec.schema, { target: 'draft-7' })),
    ) as Record<string, JsonValue>,
    parseOutput: (raw) => validate(raw) as JsonValue,
    blocks: prompt.blocks,
    composedPromptSha256: prompt.fingerprint,
    timeoutMs: 120_000,
    maxOutputTokens: 16_000,
    signal: input.signal,
  });
  assertCurrent();
  const result = await deps.router.execute(operation);
  await guard();
  const value = validate(result.output);
  const bundleReceipt = Object.freeze({
    sourceIds: identity.operation.sourceIds,
    requestId: operation.requestId,
  });
  // Parse the stage/value pair again at the storage boundary; receipts are outside cache identity.
  const write = PipelineArtifactWriteSchema.parse({
    jobId: input.jobId,
    stage: spec.stage,
    schemaVersion: 1,
    identity,
    value,
    bundleReceipt,
  });
  const artifact = await deps.artifacts.write(write, { signal: input.signal, beforeCommit: guard });
  assertCurrent();
  return Object.freeze({ artifact, identity, value, bundleReceipt });
};
