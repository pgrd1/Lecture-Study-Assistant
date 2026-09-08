import { z } from 'zod';
import { type ProviderBlock, snapshotProviderFileBlock } from '../../core/ports/aiProvider';
import { sha256CanonicalJson } from '../../core/providers/canonicalJson';
import {
  boundedPromptText,
  PROMPT_LIMITS,
  type PromptProfile,
  PromptVersionSchema,
  parsePromptProfile,
  promptInputError,
  readPromptData,
} from '../../shared/contracts/promptProfile';
import { AI_FEATURES, type AiFeature } from '../../shared/contracts/provider';
import { DEFAULT_PROMPT_CATALOG, type DefaultPromptCatalog } from './defaultPromptCatalog';
import { PROTECTED_PROMPT_RULES } from './protectedPromptRules';

export type PromptComposeInput = Readonly<{
  feature: AiFeature;
  courseId: string | null;
  globalInstructions?: string;
  courseInstructions?: string;
  featureInstructions?: string;
  oneOffInstructions?: string;
  advancedTemplateOverride?: string | null;
  profiles?: readonly PromptProfile[];
  sourceBlocks?: readonly ProviderBlock[];
}>;
export type PromptLayer = Readonly<{
  scope: 'protected' | 'default' | 'global' | 'course' | 'feature' | 'one_off';
  text: string;
  templateOverride: string | null;
  profileId: string | null;
  baseVersion: string | null;
  revision: number | null;
}>;
export type ComposedPrompt = Readonly<{
  feature: AiFeature;
  courseId: string | null;
  text: string;
  effectiveTemplate: string;
  templateOrigin: PromptLayer['scope'];
  layers: readonly PromptLayer[];
  blocks: readonly ProviderBlock[];
  systemBlock: typeof PROTECTED_PROMPT_RULES.systemBlock;
  validationRequirements: typeof PROTECTED_PROMPT_RULES.validationRequirements;
  fingerprint: string;
  promptIdentity: Readonly<{ id: string; version: 'prompt-composition-v1'; sha256: string }>;
}>;

const boundedArray = (value: unknown, max: number): readonly unknown[] => {
  if (
    !Array.isArray(value) ||
    value.length > max ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    throw promptInputError();
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable)
      throw promptInputError();
    return descriptor.value;
  });
};

const sourceBlock = (value: unknown): ProviderBlock => {
  const data = readPromptData(value, [
    'role',
    'kind',
    'text',
    'sourceId',
    'filePath',
    'mediaType',
    'sha256',
    'sizeBytes',
  ]);
  if (data.kind === 'source_file') return snapshotProviderFileBlock(data);
  const text = boundedPromptText(data.text, PROMPT_LIMITS.composedBytes);
  if (
    Object.keys(data).length !== 3 ||
    data.role !== 'user' ||
    (data.kind !== 'source' && data.kind !== 'professor_note')
  )
    throw promptInputError();
  return Object.freeze({ role: 'user', kind: data.kind, text });
};

const profileLayers = (
  data: Record<string, unknown>,
  feature: AiFeature,
  courseId: string | null,
): readonly PromptProfile[] => {
  const profiles = boundedArray(data.profiles ?? [], 3).map(parsePromptProfile);
  if (
    new Set(profiles.map((p) => p.scope)).size !== profiles.length ||
    profiles.some(
      (p) =>
        p.deleted ||
        (p.courseId !== null && p.courseId !== courseId) ||
        (p.feature !== null && p.feature !== feature),
    )
  )
    throw promptInputError();
  return profiles;
};

const editableLayer = (
  scope: 'global' | 'course' | 'feature' | 'one_off',
  data: Record<string, unknown>,
  profiles: readonly PromptProfile[],
): PromptLayer => {
  const profile = profiles.find((p) => p.scope === scope);
  const field = scope === 'one_off' ? 'oneOffInstructions' : `${scope}Instructions`;
  const additional = boundedPromptText(data[field] ?? '', PROMPT_LIMITS.instructionsBytes);
  return Object.freeze({
    scope,
    text: [profile?.additionalInstructions ?? '', additional].filter(Boolean).join('\n'),
    templateOverride:
      scope === 'one_off'
        ? ((data.advancedTemplateOverride as string | null | undefined) ?? null)
        : (profile?.templateOverride ?? null),
    profileId: profile?.id ?? null,
    baseVersion: profile?.baseVersion ?? null,
    revision: profile?.revision ?? null,
  });
};

export class PromptComposer {
  readonly catalog: DefaultPromptCatalog;

  constructor(catalog: DefaultPromptCatalog = DEFAULT_PROMPT_CATALOG) {
    const entries = readPromptData(catalog, AI_FEATURES);
    this.catalog = Object.freeze(
      Object.fromEntries(
        AI_FEATURES.map((feature) => {
          const entry = readPromptData(entries[feature], ['version', 'text']);
          const text = boundedPromptText(entry.text, PROMPT_LIMITS.templateBytes);
          if (text.trim().length === 0) throw promptInputError();
          return [
            feature,
            Object.freeze({ version: PromptVersionSchema.parse(entry.version), text }),
          ];
        }),
      ),
    ) as DefaultPromptCatalog;
    Object.freeze(this);
  }

  compose(input: PromptComposeInput): ComposedPrompt {
    const data = readPromptData(input, [
      'feature',
      'courseId',
      'globalInstructions',
      'courseInstructions',
      'featureInstructions',
      'oneOffInstructions',
      'advancedTemplateOverride',
      'profiles',
      'sourceBlocks',
    ]);
    const feature = z.enum(AI_FEATURES).parse(data.feature);
    const courseId = z.uuid().nullable().parse(data.courseId);
    if (data.advancedTemplateOverride !== undefined && data.advancedTemplateOverride !== null) {
      if (
        boundedPromptText(data.advancedTemplateOverride, PROMPT_LIMITS.templateBytes).trim()
          .length === 0
      )
        throw promptInputError();
    }
    const profiles = profileLayers(data, feature, courseId);
    const entry = this.catalog[feature];
    const layers: readonly PromptLayer[] = Object.freeze([
      Object.freeze({
        scope: 'protected',
        text: PROTECTED_PROMPT_RULES.systemBlock.text,
        templateOverride: null,
        profileId: null,
        baseVersion: PROTECTED_PROMPT_RULES.version,
        revision: null,
      }),
      Object.freeze({
        scope: 'default',
        text: entry.text,
        templateOverride: null,
        profileId: null,
        baseVersion: entry.version,
        revision: null,
      }),
      ...(['global', 'course', 'feature', 'one_off'] as const).map((scope) =>
        editableLayer(scope, data, profiles),
      ),
    ]);
    const selected = layers.findLast((layer) => layer.templateOverride !== null);
    const effectiveTemplate = selected?.templateOverride ?? entry.text;
    const instructionText = [
      effectiveTemplate,
      ...layers.slice(2).map((layer) => (layer.text ? `[${layer.scope}]\n${layer.text}` : '')),
    ]
      .filter(Boolean)
      .join('\n\n');
    const text = `${PROTECTED_PROMPT_RULES.systemBlock.text}\n\n${instructionText}`;
    boundedPromptText(text, PROMPT_LIMITS.composedBytes);
    // Also bound all layer descriptors, including overridden templates, before canonical hashing.
    const layerBytes = layers.reduce(
      (sum, layer) =>
        sum +
        new TextEncoder().encode(layer.text).byteLength +
        new TextEncoder().encode(layer.templateOverride ?? '').byteLength,
      0,
    );
    if (layerBytes > PROMPT_LIMITS.composedBytes) throw promptInputError();
    const sources = boundedArray(data.sourceBlocks ?? [], PROMPT_LIMITS.sourceBlocks).map(
      sourceBlock,
    );
    const sourceBytes = sources.reduce(
      (sum, block) =>
        sum +
        new TextEncoder().encode(block.kind === 'source_file' ? block.filePath : block.text)
          .byteLength,
      0,
    );
    if (new TextEncoder().encode(text).byteLength + sourceBytes > PROMPT_LIMITS.composedBytes)
      throw promptInputError();
    const fingerprint = sha256CanonicalJson({
      compositionVersion: 'prompt-composition-v1',
      feature,
      courseId,
      layers,
      effectiveTemplate,
      validationRequirements: PROTECTED_PROMPT_RULES.validationRequirements,
    });
    return Object.freeze({
      feature,
      courseId,
      text,
      effectiveTemplate,
      templateOrigin: selected?.scope ?? 'default',
      layers,
      blocks: Object.freeze([
        PROTECTED_PROMPT_RULES.systemBlock,
        Object.freeze({ role: 'user', kind: 'instruction', text: instructionText } as const),
        ...sources,
      ]),
      systemBlock: PROTECTED_PROMPT_RULES.systemBlock,
      validationRequirements: PROTECTED_PROMPT_RULES.validationRequirements,
      fingerprint,
      promptIdentity: Object.freeze({
        id: `composed-${feature.replaceAll('_', '-')}`,
        version: 'prompt-composition-v1',
        sha256: fingerprint,
      }),
    });
  }
}
