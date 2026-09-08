import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  createProviderOperation,
  type ProviderBlock,
  type ProviderFileBlock,
} from '../../core/ports/aiProvider';
import type { PipelineArtifactStore } from '../../core/ports/pipelineArtifactStore';
import type { ProviderRouteRepository } from '../../core/ports/providerRepositories';
import type { SourceBundleRepository } from '../../core/ports/sourceBundleRepository';
import type { SourceMetadataPort } from '../../core/ports/sourceMetadata';
import { sha256CanonicalJson } from '../../core/providers/canonicalJson';
import {
  type ContentClassificationResult,
  ContentClassificationResultSchema,
  ContentClassificationSchema,
} from '../../shared/contracts/contentClassification';
import {
  type EvidenceSegment,
  EvidenceSegmentsSchema,
  type SourceLocator,
  validateEvidenceSources,
} from '../../shared/contracts/evidence';
import {
  assertBoundedPipelineJson,
  type PipelineArtifact,
  type PipelineArtifactWrite,
  type PipelineOperationReceipts,
  type PipelineStageIdentity,
  PipelineStageIdentitySchema,
} from '../../shared/contracts/pipelineArtifact';
import {
  type AiFeature,
  type JsonValue,
  type ProviderRoute,
  ProviderRouteSchema,
} from '../../shared/contracts/provider';
import {
  SourceBundleSchema,
  type SourceRecord,
  SourceRecordSchema,
} from '../../shared/contracts/sourceBundle';
import {
  metadataContainsLocator,
  type TrustedSourceMetadata,
  TrustedSourceMetadataSchema,
} from '../../shared/contracts/sourceMetadata';
import { APP_ERROR_MESSAGES, AppError, type ProviderErrorCode } from '../../shared/errors';
import type { ComposedPrompt, PromptComposeInput, PromptComposer } from '../prompts/promptComposer';
import type { AiProviderRouter } from '../providers/aiProviderRouter';
import { type ContentContextBlocks, snapshotContentAttempt } from './contentAttemptSnapshot';
import { rethrowMetadataFailure } from './metadataFailure';
import { readNormalizedSourceText } from './sourceTextNormalizer';

export type ContentPromptInput = Omit<PromptComposeInput, 'feature' | 'courseId' | 'sourceBlocks'>;
export type ContentPipelineInput = Readonly<{
  jobId: string;
  courseId: string;
  signal: AbortSignal;
  contextBlocks?: ContentContextBlocks;
  prompts?: Readonly<Partial<Record<AiFeature, ContentPromptInput>>>;
}>;
export type ContentPipelineDependencies = Readonly<{
  bundles: SourceBundleRepository;
  routes: Pick<ProviderRouteRepository, 'get'>;
  artifacts: PipelineArtifactStore;
  metadata: SourceMetadataPort;
  router: Pick<AiProviderRouter, 'execute'>;
  composer: PromptComposer;
  promptInputs?: ((courseId: string) => ContentPipelineInput['prompts']) | undefined;
  assertAttemptCurrent?: () => void;
  lifetimeSignal?: AbortSignal;
}>;
export type StageResult<T> = Readonly<{
  artifact: PipelineArtifact;
  identity: PipelineStageIdentity;
  value: T;
  operationReceipts: PipelineOperationReceipts;
}>;
export type ExtractionResult = z.infer<typeof EvidenceSegmentsSchema>;
type Stage = 'classification' | 'extraction' | 'evidence';
type Source = Readonly<{ record: SourceRecord; metadata: TrustedSourceMetadata }>;
type Plan = Readonly<{
  source: Source;
  feature: AiFeature;
  prompt: ComposedPrompt;
  editable: ContentPromptInput;
  route: ProviderRoute;
}>;
type Context = Readonly<{
  input: ContentPipelineInput;
  plans: readonly Plan[];
  identity: PipelineStageIdentity;
}>;

export const contentError = (code: ProviderErrorCode = 'PROVIDER_OUTPUT_INVALID'): AppError =>
  new AppError(code, APP_ERROR_MESSAGES[code]);
const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw contentError();
  return value;
};
export const assertContentActive = (signal: AbortSignal): void => {
  if (signal.aborted) throw contentError('PROVIDER_CANCELLED');
};

const featureFor = (stage: Stage, source: SourceRecord): AiFeature => {
  if (stage === 'classification') return 'content_classification';
  if (stage === 'evidence' || /\.(?:txt|md)$/iu.test(source.originalFileName))
    return 'media_extraction';
  return source.mediaType === 'audio' ? 'audio_transcription' : 'document_recognition';
};

const recordsFor = (
  deps: ContentPipelineDependencies,
  input: ContentPipelineInput,
): readonly SourceRecord[] => {
  z.uuid().parse(input.jobId);
  z.uuid().parse(input.courseId);
  assertContentActive(input.signal);
  const bundle = SourceBundleSchema.parse(deps.bundles.getByJobId(input.jobId));
  const records = z
    .array(SourceRecordSchema)
    .min(1)
    .max(32)
    .parse(deps.bundles.listRecords(bundle.id));
  if (
    bundle.jobId !== input.jobId ||
    bundle.sourceCount !== records.length ||
    new Set(records.map((v) => v.id)).size !== records.length ||
    records.some((v, i) => v.bundleId !== bundle.id || v.ordinal !== i) ||
    records.reduce((sum, v) => sum + v.sizeBytes, 0) !== bundle.totalBytes
  )
    throw contentError();
  return Object.freeze(records);
};

const prepare = async (
  deps: ContentPipelineDependencies,
  input: ContentPipelineInput,
  stage: Stage,
  upstream: PipelineStageIdentity['upstream'],
): Promise<Context> => {
  const records = recordsFor(deps, input);
  // Snapshot bounded editable inputs before asynchronous reads. Source content never enters these layers.
  const drafts = records.map((record) => {
    const feature = featureFor(stage, record);
    const prompt = deps.composer.compose({
      ...input.prompts?.[feature],
      feature,
      courseId: input.courseId,
      sourceBlocks: [],
    });
    const editable = JSON.parse(
      JSON.stringify(input.prompts?.[feature] ?? {}),
    ) as ContentPromptInput;
    const saved = deps.routes.get(feature);
    if (saved === null) throw contentError('PROVIDER_NOT_CONFIGURED');
    return { record, feature, prompt, editable, route: ProviderRouteSchema.parse(saved) };
  });
  const plans: Plan[] = [];
  for (const draft of drafts) {
    assertContentActive(input.signal);
    const raw = await deps.metadata
      .measure(draft.record, input.signal)
      .catch((error: unknown) => rethrowMetadataFailure(error, input.signal));
    assertContentActive(input.signal);
    assertBoundedPipelineJson(raw);
    const metadata = TrustedSourceMetadataSchema.parse(raw);
    if (
      metadata.sourceId !== draft.record.id ||
      metadata.sha256 !== draft.record.sha256 ||
      metadata.sizeBytes !== draft.record.sizeBytes
    )
      throw contentError();
    plans.push(
      Object.freeze({ ...draft, source: Object.freeze({ record: draft.record, metadata }) }),
    );
  }
  const identity = PipelineStageIdentitySchema.parse({
    identityVersion: 4,
    operationVersion: 'content-stages-v2',
    contextSha256: sha256CanonicalJson(input.contextBlocks ?? []),
    sources: plans.map(({ source }) => ({
      sourceId: source.record.id,
      sha256: source.record.sha256,
      metadata: {
        parserVersion: source.metadata.parserVersion,
        policyVersion: source.metadata.policyVersion,
        factsSha256: sha256CanonicalJson(source.metadata.facts),
      },
    })),
    upstream,
    operations: plans.map(({ source, prompt, route }) => ({
      sourceId: source.record.id,
      prompt: prompt.promptIdentity,
      route,
    })),
  });
  assertContentActive(input.signal);
  return Object.freeze({
    input,
    plans: Object.freeze(plans),
    identity,
  });
};

const assertRoutesCurrent = (deps: ContentPipelineDependencies, context: Context): void => {
  deps.assertAttemptCurrent?.();
  assertContentActive(context.input.signal);
  for (const plan of context.plans) {
    if (sha256CanonicalJson(deps.routes.get(plan.feature)) !== sha256CanonicalJson(plan.route))
      throw contentError('PROVIDER_NOT_READY');
  }
};

const fileBlock = (source: SourceRecord): ProviderFileBlock =>
  Object.freeze({
    role: 'user',
    kind: 'source_file',
    sourceId: source.id,
    filePath: source.stagedPath,
    sha256: source.sha256,
    sizeBytes: source.sizeBytes,
    mediaType: source.mediaType,
  });
const sourceBlock = (value: unknown): ProviderBlock => {
  assertBoundedPipelineJson(value);
  return Object.freeze({ role: 'user', kind: 'source', text: JSON.stringify(value) });
};

const rawBlocks = async (plan: Plan, signal: AbortSignal): Promise<readonly ProviderBlock[]> => {
  const block = fileBlock(plan.source.record);
  if (plan.source.metadata.facts.kind !== 'text') return [block];
  const text = await readNormalizedSourceText(block, signal);
  if (
    text.length !== plan.source.metadata.facts.normalizedCodeUnits ||
    text.split('\n').length !== plan.source.metadata.facts.lineCount
  )
    throw contentError();
  return [Object.freeze({ role: 'user', kind: 'source', text })];
};

const rejectOutputPaths = (value: unknown, records: readonly SourceRecord[]): void => {
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      const normalized = node.replaceAll('\\', '/').toLowerCase();
      if (
        /(?:[a-z]:[\\/]|file:\/\/|\\\\[^\\\s]+\\)/iu.test(node) ||
        records.some((record) =>
          normalized.includes(record.stagedPath.replaceAll('\\', '/').toLowerCase()),
        )
      )
        throw contentError();
    } else if (Array.isArray(node)) node.forEach(visit);
    else if (node !== null && typeof node === 'object') Object.values(node).forEach(visit);
  };
  visit(value);
};

const parseBounded = <T>(schema: z.ZodType<T>, value: unknown, context: Context): T => {
  try {
    assertBoundedPipelineJson(value);
    const parsed = schema.parse(value);
    rejectOutputPaths(
      parsed,
      context.plans.map((p) => p.source.record),
    );
    return parsed;
  } catch {
    throw contentError();
  }
};

const parseClassification = (value: unknown, plan: Plan, context: Context) => {
  const result = parseBounded(ContentClassificationSchema, value, context);
  if (
    result.sourceId !== plan.source.record.id ||
    [...result.sections, ...result.facts].some(
      (v) => !metadataContainsLocator(plan.source.metadata.facts, v.locator),
    )
  )
    throw contentError();
  return result;
};

const locatorWithin = (locator: SourceLocator, parent: SourceLocator): boolean => {
  if (locator.kind === 'audio' && parent.kind === 'audio')
    return locator.startMs >= parent.startMs && locator.endMs <= parent.endMs;
  if (locator.kind === 'text' && parent.kind === 'text')
    return locator.startLine >= parent.startLine && locator.endLine <= parent.endLine;
  if (locator.kind === 'image' && parent.kind === 'image')
    return (
      locator.x >= parent.x &&
      locator.y >= parent.y &&
      locator.x + locator.width <= parent.x + parent.width &&
      locator.y + locator.height <= parent.y + parent.height
    );
  return sha256CanonicalJson(locator) === sha256CanonicalJson(parent);
};

const parseSegments = (
  value: unknown,
  plan: Plan,
  context: Context,
  upstream?: readonly EvidenceSegment[],
): ExtractionResult => {
  const result = parseBounded(EvidenceSegmentsSchema, value, context);
  try {
    validateEvidenceSources(result.segments, [plan.source.record.id]);
  } catch {
    throw contentError();
  }
  if (
    result.segments.length === 0 ||
    result.segments.some(
      (v) =>
        !metadataContainsLocator(plan.source.metadata.facts, v.locator) ||
        (upstream !== undefined &&
          !upstream.some(
            (parent) => parent.sourceId === v.sourceId && locatorWithin(v.locator, parent.locator),
          )),
    )
  )
    throw contentError();
  return result;
};

const execute = async <T>(
  deps: ContentPipelineDependencies,
  context: Context,
  plan: Plan,
  schema: z.ZodType<T>,
  parseOutput: (value: unknown) => T,
  sources: readonly ProviderBlock[],
): Promise<Readonly<{ value: T; receipt: PipelineOperationReceipts[number] }>> => {
  const blocks = [
    sourceBlock({ sourceId: plan.source.record.id, bounds: plan.source.metadata.facts }),
    ...sources,
    ...(context.input.contextBlocks ?? []),
  ];
  const composed = deps.composer.compose({
    ...plan.editable,
    feature: plan.feature,
    courseId: context.input.courseId,
    sourceBlocks: blocks,
  });
  if (composed.fingerprint !== plan.prompt.fingerprint) throw contentError();
  // Serialize only our own generated schema to remove Zod's non-enumerable Standard Schema marker.
  const outputJsonSchema = JSON.parse(
    JSON.stringify(z.toJSONSchema(schema, { target: 'draft-7' })),
  ) as Record<string, JsonValue>;
  const parseJsonOutput = (value: unknown): JsonValue => {
    const parsed = parseOutput(value);
    assertBoundedPipelineJson(parsed);
    return parsed as JsonValue;
  };
  const operation = createProviderOperation({
    requestId: randomUUID(),
    feature: plan.feature,
    jobId: context.input.jobId,
    outputSchemaId:
      plan.feature === 'content_classification' ? 'content_classification' : 'evidence_segments',
    outputJsonSchema,
    parseOutput: parseJsonOutput,
    blocks: composed.blocks,
    composedPromptSha256: composed.fingerprint,
    timeoutMs: 120_000,
    maxOutputTokens: 16_000,
    signal: context.input.signal,
  });
  assertRoutesCurrent(deps, context);
  const result = await deps.router.execute(operation);
  assertRoutesCurrent(deps, context);
  return Object.freeze({
    value: parseOutput(result.output),
    receipt: Object.freeze({ sourceId: plan.source.record.id, requestId: operation.requestId }),
  });
};

const readCache = async (deps: ContentPipelineDependencies, context: Context, stage: Stage) => {
  assertRoutesCurrent(deps, context);
  const cached = await deps.artifacts.read(
    context.input.jobId,
    stage,
    context.identity,
    stage === 'classification' ? 2 : 1,
  );
  assertRoutesCurrent(deps, context);
  return cached;
};

const publish = async <T>(
  deps: ContentPipelineDependencies,
  context: Context,
  write: PipelineArtifactWrite,
  value: T,
  upstream?: StageResult<unknown>,
): Promise<StageResult<T>> => {
  assertRoutesCurrent(deps, context);
  const artifact = await deps.artifacts.write(write, {
    signal: context.input.signal,
    beforeCommit: async () => {
      if (upstream !== undefined) await requireCurrentUpstream(deps, context.input, upstream);
      assertRoutesCurrent(deps, context);
    },
  });
  assertContentActive(context.input.signal);
  if (!('operationReceipts' in write) || write.operationReceipts === undefined)
    throw contentError();
  return Object.freeze({
    artifact,
    identity: context.identity,
    value,
    operationReceipts: write.operationReceipts,
  });
};

const requireCurrentUpstream = async (
  deps: ContentPipelineDependencies,
  input: ContentPipelineInput,
  upstream: StageResult<unknown>,
): Promise<void> => {
  assertContentActive(input.signal);
  const checkRoutes = () => {
    for (const operation of upstream.identity.operations) {
      if (
        sha256CanonicalJson(deps.routes.get(operation.route.feature)) !==
        sha256CanonicalJson(operation.route)
      )
        throw contentError('PROVIDER_NOT_READY');
    }
  };
  checkRoutes();
  const current = await deps.artifacts.read(
    input.jobId,
    upstream.artifact.stage,
    upstream.identity,
    upstream.artifact.schemaVersion,
  );
  assertContentActive(input.signal);
  if (current?.sha256 !== upstream.artifact.sha256) throw contentError();
  checkRoutes();
};

export const classifyStage = async (
  deps: ContentPipelineDependencies,
  input: ContentPipelineInput,
): Promise<StageResult<ContentClassificationResult>> => {
  ({ dependencies: deps, input } = snapshotContentAttempt(deps, input));
  const context = await prepare(deps, input, 'classification', []);
  const validate = (value: unknown): ContentClassificationResult => {
    const result = parseBounded(ContentClassificationResultSchema, value, context);
    if (result.classifications.length !== context.plans.length) throw contentError();
    result.classifications.forEach((item, i) => {
      parseClassification(item, required(context.plans[i]), context);
    });
    return result;
  };
  const cached = await readCache(deps, context, 'classification');
  if (cached !== null)
    return Object.freeze({
      artifact: cached,
      identity: context.identity,
      value: validate(cached.value),
      operationReceipts: required(
        'operationReceipts' in cached ? cached.operationReceipts : undefined,
      ),
    });
  const results = [];
  const operationReceipts = [];
  for (const plan of context.plans) {
    assertContentActive(input.signal);
    const result = await execute(
      deps,
      context,
      plan,
      ContentClassificationSchema,
      (value) => parseClassification(value, plan, context),
      await rawBlocks(plan, input.signal),
    );
    results.push(result.value);
    operationReceipts.push(result.receipt);
    parseBounded(ContentClassificationResultSchema, { classifications: results }, context);
  }
  const value = validate({ classifications: results });
  return publish(
    deps,
    context,
    {
      jobId: input.jobId,
      stage: 'classification',
      schemaVersion: 2,
      identity: context.identity,
      value,
      operationReceipts,
    },
    value,
  );
};

const extractStage = async (
  deps: ContentPipelineDependencies,
  input: ContentPipelineInput,
  stage: 'extraction' | 'evidence',
  upstream: StageResult<ContentClassificationResult> | StageResult<ExtractionResult>,
): Promise<StageResult<ExtractionResult>> => {
  const context = await prepare(deps, input, stage, [
    { stage: upstream.artifact.stage, sha256: upstream.artifact.sha256 },
  ]);
  // Reject sources/bounds changed while the preceding stage was running.
  if (
    sha256CanonicalJson(context.identity.sources) !== sha256CanonicalJson(upstream.identity.sources)
  )
    throw contentError();
  const parents = (sourceId: string) =>
    'segments' in upstream.value
      ? upstream.value.segments.filter((v) => v.sourceId === sourceId)
      : undefined;
  await requireCurrentUpstream(deps, input, upstream);
  const validate = (value: unknown): ExtractionResult => {
    const result = parseBounded(EvidenceSegmentsSchema, value, context);
    try {
      validateEvidenceSources(
        result.segments,
        context.plans.map((p) => p.source.record.id),
      );
    } catch {
      throw contentError();
    }
    let offset = 0;
    for (const plan of context.plans) {
      const own = result.segments.filter((v) => v.sourceId === plan.source.record.id);
      parseSegments({ segments: own }, plan, context, parents(plan.source.record.id));
      if (own.some((v, i) => result.segments[offset + i] !== v)) throw contentError();
      offset += own.length;
    }
    return result;
  };
  const cached = await readCache(deps, context, stage);
  await requireCurrentUpstream(deps, input, upstream);
  assertRoutesCurrent(deps, context);
  if (cached !== null)
    return Object.freeze({
      artifact: cached,
      identity: context.identity,
      value: validate(cached.value),
      operationReceipts: required(
        'operationReceipts' in cached ? cached.operationReceipts : undefined,
      ),
    });
  const results: EvidenceSegment[] = [];
  const operationReceipts = [];
  for (const plan of context.plans) {
    assertContentActive(input.signal);
    const parentSegments = parents(plan.source.record.id);
    const blocks =
      parentSegments === undefined
        ? await rawBlocks(plan, input.signal)
        : [sourceBlock({ segments: parentSegments })];
    const result = await execute(
      deps,
      context,
      plan,
      EvidenceSegmentsSchema,
      (value) => parseSegments(value, plan, context, parentSegments),
      blocks,
    );
    results.push(...result.value.segments);
    operationReceipts.push(result.receipt);
    parseBounded(EvidenceSegmentsSchema, { segments: results }, context);
  }
  const value = validate({ segments: results });
  await requireCurrentUpstream(deps, input, upstream);
  return publish(
    deps,
    context,
    {
      jobId: input.jobId,
      stage,
      schemaVersion: 1,
      identity: context.identity,
      value,
      operationReceipts,
    },
    value,
    upstream,
  );
};

export const extractSourcesStage = async (
  deps: ContentPipelineDependencies,
  input: ContentPipelineInput,
): Promise<StageResult<ExtractionResult>> => {
  const attempt = snapshotContentAttempt(deps, input);
  return extractStage(
    attempt.dependencies,
    attempt.input,
    'extraction',
    await classifyStage(attempt.dependencies, attempt.input),
  );
};

export const extractEvidenceStage = async (
  deps: ContentPipelineDependencies,
  input: ContentPipelineInput,
): Promise<StageResult<ExtractionResult>> => {
  const attempt = snapshotContentAttempt(deps, input);
  return extractStage(
    attempt.dependencies,
    attempt.input,
    'evidence',
    await extractSourcesStage(attempt.dependencies, attempt.input),
  );
};

/** Keep the complete dependency chain available for downstream publication guards. */
export const extractEvidencePipelineStages = async (
  deps: ContentPipelineDependencies,
  input: ContentPipelineInput,
) => {
  const classification = await classifyStage(deps, input);
  const extraction = await extractStage(deps, input, 'extraction', classification);
  const evidence = await extractStage(deps, input, 'evidence', extraction);
  return Object.freeze({ classification, extraction, evidence });
};
