import { randomUUID } from 'node:crypto';
import type { PromptProfileRepository } from '../../core/ports/promptProfileRepository';
import {
  boundedPromptText,
  PROMPT_LIMITS,
  PromptNameSchema,
  type PromptProfile,
  type PromptProfileKey,
  type PromptProfileValues,
  PromptRevisionSchema,
  parsePromptKey,
  parsePromptProfile,
  parsePromptValues,
  promptInputError,
  readPromptData,
} from '../../shared/contracts/promptProfile';
import { APP_ERROR_MESSAGES, AppError } from '../../shared/errors';
import { DEFAULT_PROMPT_CATALOG, type DefaultPromptCatalog } from './defaultPromptCatalog';
import { type ComposedPrompt, type PromptComposeInput, PromptComposer } from './promptComposer';

export type ProfileComposeInput = Omit<PromptComposeInput, 'profiles'>;
const stale = (): AppError => new AppError('STALE_WRITE', APP_ERROR_MESSAGES.STALE_WRITE);

export class PromptProfileService {
  readonly #repository: PromptProfileRepository;
  readonly #composer: PromptComposer;
  constructor(
    repository: PromptProfileRepository,
    catalog: DefaultPromptCatalog = DEFAULT_PROMPT_CATALOG,
  ) {
    this.#repository = repository;
    this.#composer = new PromptComposer(catalog);
  }

  get(key: PromptProfileKey): PromptProfile | null {
    const profile = this.#repository.getCurrent(parsePromptKey(key));
    return profile?.deleted ? null : profile;
  }
  list(): readonly PromptProfile[] {
    return this.#repository.list();
  }
  history(key: PromptProfileKey): readonly PromptProfile[] {
    return this.#repository.history(parsePromptKey(key));
  }

  save(
    key: PromptProfileKey,
    values: PromptProfileValues,
    expectedRevision: number | null,
  ): PromptProfile {
    const parsedKey = parsePromptKey(key);
    const parsedValues = parsePromptValues(values);
    return this.#write(
      parsedKey,
      parsedValues,
      expectedRevision,
      false,
      this.#baseVersion(parsedKey),
    );
  }

  reset(key: PromptProfileKey, expectedRevision: number, name: string): PromptProfile {
    return this.save(
      key,
      { name, additionalInstructions: '', templateOverride: null },
      PromptRevisionSchema.parse(expectedRevision),
    );
  }

  remove(key: PromptProfileKey, expectedRevision: number): PromptProfile {
    const parsedKey = parsePromptKey(key);
    const revision = PromptRevisionSchema.parse(expectedRevision);
    return this.#write(
      parsedKey,
      { name: '삭제', additionalInstructions: '', templateOverride: null },
      revision,
      true,
      this.#baseVersion(parsedKey),
    );
  }

  rollback(
    key: PromptProfileKey,
    targetRevision: number,
    expectedRevision: number,
    name: string,
  ): PromptProfile {
    const parsedKey = parsePromptKey(key);
    const target = this.#revision(parsedKey, targetRevision);
    return this.#write(
      parsedKey,
      {
        name: PromptNameSchema.parse(name),
        additionalInstructions: target.additionalInstructions,
        templateOverride: target.templateOverride,
      },
      PromptRevisionSchema.parse(expectedRevision),
      target.deleted,
      target.baseVersion,
    );
  }

  diff(key: PromptProfileKey, fromRevision: number, toRevision: number) {
    const before = this.#revision(key, fromRevision);
    const after = this.#revision(key, toRevision);
    const fields = [
      'additionalInstructions',
      'templateOverride',
      'name',
      'baseVersion',
      'deleted',
    ] as const;
    return Object.freeze({
      before,
      after,
      changedFields: Object.freeze(fields.filter((field) => before[field] !== after[field])),
    });
  }

  compose(input: ProfileComposeInput): ComposedPrompt {
    // Validate input before repository access and reject caller-supplied profile metadata.
    const data = readPromptData(input, [
      'feature',
      'courseId',
      'globalInstructions',
      'courseInstructions',
      'featureInstructions',
      'oneOffInstructions',
      'advancedTemplateOverride',
      'sourceBlocks',
    ]);
    const validated = this.#composer.compose(data as ProfileComposeInput);
    const { feature, courseId } = validated;
    const global = this.get({ scope: 'global', courseId: null, feature: null });
    const course =
      courseId === null ? null : this.get({ scope: 'course', courseId, feature: null });
    // A course-specific feature profile replaces the global feature profile as one layer.
    const featureProfile =
      (courseId === null ? null : this.get({ scope: 'feature', courseId, feature })) ??
      this.get({ scope: 'feature', courseId: null, feature });
    return this.#composer.compose({
      ...input,
      profiles: [global, course, featureProfile].filter((p): p is PromptProfile => p !== null),
    });
  }

  diffFromDefault(key: PromptProfileKey) {
    const parsed = parsePromptKey(key);
    const current = this.get(parsed);
    const changedFields = [
      ...(current !== null && current.additionalInstructions !== ''
        ? ['additionalInstructions']
        : []),
      ...(current !== null && current.templateOverride !== null ? ['templateOverride'] : []),
    ];
    return Object.freeze({
      current,
      baseVersion: this.#baseVersion(parsed),
      defaultTemplate: parsed.feature === null ? null : this.#composer.catalog[parsed.feature].text,
      changedFields: Object.freeze(changedFields),
    });
  }

  preview(input: ProfileComposeInput, example: string) {
    const text = boundedPromptText(example, PROMPT_LIMITS.previewBytes);
    const composition = this.compose(input);
    return Object.freeze({
      mode: 'local' as const,
      providerCallRequired: false as const,
      composition,
      exampleBlock: Object.freeze({ role: 'user', kind: 'source', text } as const),
    });
  }

  #baseVersion(key: PromptProfileKey): string {
    return key.feature === null ? 'prompt-profile-v1' : this.#composer.catalog[key.feature].version;
  }

  #revision(key: PromptProfileKey, revision: number): PromptProfile {
    const parsedRevision = PromptRevisionSchema.parse(revision);
    const result = this.history(key).find((entry) => entry.revision === parsedRevision);
    if (result === undefined) throw promptInputError();
    return result;
  }

  #write(
    key: PromptProfileKey,
    values: PromptProfileValues,
    expectedRevision: number | null,
    deleted: boolean,
    baseVersion: string,
  ): PromptProfile {
    if (expectedRevision !== null) PromptRevisionSchema.parse(expectedRevision);
    const current = this.#repository.getCurrent(key);
    if ((current?.revision ?? null) !== expectedRevision) throw stale();
    const now = new Date().toISOString();
    const profile = parsePromptProfile({
      ...key,
      ...values,
      id: current?.id ?? randomUUID(),
      baseVersion,
      revision: current === null ? 0 : current.revision + 1,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
      deleted,
    });
    return this.#repository.save(profile, expectedRevision);
  }
}
