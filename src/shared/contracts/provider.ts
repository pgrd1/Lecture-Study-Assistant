import { z } from 'zod';
import { type AppErrorCode, type ProviderErrorCode, ProviderErrorCodeSchema } from '../errors';

export const AI_FEATURES = Object.freeze([
  'content_classification',
  'media_extraction',
  'topic_clustering',
  'source_question_extraction',
  'question_variation',
  'course_question_answer',
  'audio_transcription',
  'document_recognition',
  'core_summary',
  'lecture_organize',
  'lecture_verify',
  'professor_profile',
  'exam_synthesis',
  'question_generation',
  'answer_verification',
  'grading_feedback',
] as const);

export const AI_PROVIDER_IDS = Object.freeze([
  'antigravity_cli',
  'gemini_cli',
  'codex_cli',
  'gemini_api',
  'openai_api',
  'claude_api',
] as const);

export const CLI_PROVIDER_IDS = Object.freeze([
  'antigravity_cli',
  'gemini_cli',
  'codex_cli',
] as const);

export const API_PROVIDER_IDS = Object.freeze(['gemini_api', 'openai_api', 'claude_api'] as const);

export const PRIMARY_GENERATION_FEATURES = Object.freeze([
  'lecture_organize',
  'professor_profile',
  'exam_synthesis',
  'question_generation',
  'grading_feedback',
] as const);

export const VERIFICATION_FEATURES = Object.freeze([
  'lecture_verify',
  'answer_verification',
] as const);

export const ANTIGRAVITY_HISTORY_NOTICE_VERSION = 'antigravity-history-v1' as const;
export const SHARED_CREDENTIAL_NOTICE_VERSION = 'shared-cli-credential-v1' as const;

export const TRUSTED_CLI_BINDING_RECIPES = Object.freeze({
  antigravity_cli: Object.freeze({
    recipeId: 'antigravity-1.1-stream-json-v1',
    launcherPrefix: 'none',
  }),
  gemini_cli: Object.freeze({
    recipeId: 'gemini-0.55-policy-json-v1',
    launcherPrefix: 'canonical_entry_path',
  }),
  codex_cli: Object.freeze({
    recipeId: 'codex-0.146-profile-keyring-v2',
    launcherPrefix: 'none',
  }),
} as const);

export const DEFAULT_PROMPT_VERSION_BY_FEATURE = Object.freeze({
  content_classification: 'content-classification-v1',
  media_extraction: 'media-extraction-v1',
  topic_clustering: 'topic-clustering-v1',
  source_question_extraction: 'source-question-extraction-v1',
  question_variation: 'question-variation-v1',
  course_question_answer: 'course-question-answer-v1',
  audio_transcription: 'audio-transcription-v1',
  document_recognition: 'document-recognition-v1',
  core_summary: 'core-summary-v1',
  lecture_organize: 'lecture-organize-v1',
  lecture_verify: 'lecture-verify-v1',
  professor_profile: 'professor-profile-v1',
  exam_synthesis: 'exam-synthesis-v1',
  question_generation: 'question-generation-v1',
  answer_verification: 'answer-verification-v1',
  grading_feedback: 'grading-feedback-v1',
} satisfies Record<AiFeature, string>);

export const CREDENTIAL_SCOPES = Object.freeze([
  'not_applicable',
  'profile_scoped',
  'provider_global',
  'unknown',
] as const);

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | Readonly<{ [key: string]: JsonValue }>;
export type AiFeature = (typeof AI_FEATURES)[number];
export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];
export type CliProviderId = (typeof CLI_PROVIDER_IDS)[number];
export type ApiProviderId = (typeof API_PROVIDER_IDS)[number];
export type CredentialScope = (typeof CREDENTIAL_SCOPES)[number];

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SAFE_SEMVER_PATTERN =
  /^v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*)|(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:(?:0|[1-9]\d*)|(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const CONTROL_OR_FORMAT_CHARACTER = /[\p{Cc}\p{Cf}]/u;
const SHA_256_PATTERN = /^[a-f0-9]{64}$/;
export const Sha256Schema = z.string().regex(SHA_256_PATTERN);

export const ModelIdSchema = z.string().regex(MODEL_ID_PATTERN);
const SafeTextSchema = z
  .string()
  .refine(
    (value) => !CONTROL_OR_FORMAT_CHARACTER.test(value),
    '제공자 표시명에 제어 문자를 사용할 수 없습니다.',
  )
  .transform((value) => value.trim())
  .pipe(z.string().min(1).max(120));
export const SafeSemVerSchema = z
  .string()
  .regex(SAFE_SEMVER_PATTERN)
  .transform((value) => value.replace(/^v/, '') as SafeSemVer);
export type SafeSemVer = string & { readonly __safeSemVer: unique symbol };
export const parseSafeSemVer = (value: string): SafeSemVer => SafeSemVerSchema.parse(value);
const ProviderDisplayTextSchema = SafeTextSchema;
const KoreanAppTextSchema = SafeTextSchema.pipe(z.string().max(240));
const IsoDateTimeSchema = z.iso.datetime({ offset: true });
const RevisionSchema = z.int().min(0);
const UNKNOWN_CLI_STATUSES = Object.freeze([
  'not_checked',
  'missing_executable',
  'missing_credential',
  'unsafe_version',
] as const);

export const ProviderStatusSchema = z.enum([
  'not_checked',
  'installed',
  'credential_saved',
  'missing_executable',
  'missing_credential',
  'unsafe_version',
  'ready',
  'auth_required',
  'account_unsupported',
  'incompatible_model',
  'quota_or_billing',
  'temporarily_unavailable',
  'invalid_provider_output',
]);
export type ProviderStatus = z.infer<typeof ProviderStatusSchema>;

export const ProviderRouteSchema = z
  .strictObject({
    feature: z.enum(AI_FEATURES),
    providerId: z.enum(AI_PROVIDER_IDS).nullable(),
    modelId: ModelIdSchema.nullable(),
    promptVersion: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    enabled: z.boolean(),
    providerManagedHistoryConsentAt: IsoDateTimeSchema.nullable(),
    providerManagedHistoryConsentVersion: z.literal(ANTIGRAVITY_HISTORY_NOTICE_VERSION).nullable(),
    updatedAt: IsoDateTimeSchema,
    revision: RevisionSchema,
  })
  .superRefine((value, context) => {
    const apiProvider = value.providerId?.endsWith('_api') === true;
    if (value.enabled && value.providerId === null) {
      context.addIssue({
        code: 'custom',
        path: ['providerId'],
        message: '활성 경로에는 AI 제공자가 필요합니다.',
      });
    }
    if (value.providerId === null && value.modelId !== null) {
      context.addIssue({
        code: 'custom',
        path: ['modelId'],
        message: 'AI 제공자 없이 모델만 선택할 수 없습니다.',
      });
    }
    if (apiProvider && value.modelId === null) {
      context.addIssue({
        code: 'custom',
        path: ['modelId'],
        message: 'API 경로에는 모델 선택이 필요합니다.',
      });
    }
    if (
      (value.providerManagedHistoryConsentAt === null) !==
      (value.providerManagedHistoryConsentVersion === null)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['providerManagedHistoryConsentVersion'],
        message: '제공자 기록 동의 시각과 버전은 함께 저장해야 합니다.',
      });
    }
    if (value.providerManagedHistoryConsentAt !== null && value.providerId !== 'antigravity_cli') {
      context.addIssue({
        code: 'custom',
        path: ['providerManagedHistoryConsentAt'],
        message: '제공자 기록 동의는 Antigravity CLI 경로에만 저장할 수 있습니다.',
      });
    }
  })
  .readonly();
export type ProviderRoute = z.infer<typeof ProviderRouteSchema>;

const NamedProviderModelSchema = z
  .strictObject({
    modelId: ModelIdSchema,
    displayName: ProviderDisplayTextSchema,
    compatibility: z.enum(['unverified', 'compatible', 'incompatible']),
  })
  .readonly();

export const CLI_DEFAULT_MODEL_DISPLAY_NAMES = Object.freeze({
  gemini_cli: 'CLI 기본 모델',
  codex_cli: 'Codex CLI 로그인 기본 모델',
} as const);

const CliDefaultProviderModelSchema = z
  .strictObject({
    modelId: z.null(),
    displayName: z.enum([
      CLI_DEFAULT_MODEL_DISPLAY_NAMES.gemini_cli,
      CLI_DEFAULT_MODEL_DISPLAY_NAMES.codex_cli,
    ]),
    compatibility: z.literal('unverified'),
  })
  .readonly();

export const ProviderModelSchema = z.union([
  NamedProviderModelSchema,
  CliDefaultProviderModelSchema,
]);
export type ProviderModel = z.infer<typeof ProviderModelSchema>;

// Official GPT-5.5 image-input snapshot; account availability still needs a successful probe.
export const CODEX_IMAGE_MODEL_ID = 'gpt-5.5-2026-04-23';

export const ProviderModelListStateSchema = z
  .strictObject({
    providerId: z.enum(AI_PROVIDER_IDS),
    models: z.array(ProviderModelSchema).max(1_000).readonly(),
    checkedAt: IsoDateTimeSchema.nullable(),
  })
  .superRefine((value, context) => {
    const nullModels = value.models.filter((model) => model.modelId === null);
    if (new Set(value.models.map((model) => model.modelId)).size !== value.models.length) {
      context.addIssue({
        code: 'custom',
        path: ['models'],
        message: '모델 ID는 중복될 수 없습니다.',
      });
    }
    if (nullModels.length === 0) return;
    const expectedDisplayName =
      value.providerId === 'gemini_cli'
        ? CLI_DEFAULT_MODEL_DISPLAY_NAMES.gemini_cli
        : value.providerId === 'codex_cli'
          ? CLI_DEFAULT_MODEL_DISPLAY_NAMES.codex_cli
          : null;
    if (
      (value.models.length !== 1 &&
        !(
          value.providerId === 'codex_cli' &&
          value.models.length === 2 &&
          value.models.some((model) => model.modelId === CODEX_IMAGE_MODEL_ID)
        )) ||
      nullModels.length !== 1 ||
      expectedDisplayName === null ||
      nullModels[0]?.displayName !== expectedDisplayName ||
      nullModels[0]?.compatibility !== 'unverified'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['models'],
        message: 'CLI 기본 모델은 검토된 제공자의 단일 선택지로만 표시할 수 있습니다.',
      });
    }
  })
  .readonly();
export type ProviderModelListState = z.infer<typeof ProviderModelListStateSchema>;

export const ProviderCardStateSchema = z
  .strictObject({
    providerId: z.enum(AI_PROVIDER_IDS),
    kind: z.enum(['cli', 'api']),
    displayName: KoreanAppTextSchema,
    notices: z.array(KoreanAppTextSchema).max(12).readonly(),
    status: ProviderStatusSchema,
    errorCode: ProviderErrorCodeSchema.nullable(),
    version: SafeSemVerSchema.nullable(),
    selectedModelId: ModelIdSchema.nullable(),
    reportedModelId: ModelIdSchema.nullable(),
    credentialPresent: z.boolean(),
    checkedAt: IsoDateTimeSchema.nullable(),
    providerManagedHistory: z.boolean(),
    credentialScope: z.enum(CREDENTIAL_SCOPES),
    sharedCredentialConsentRequired: z.boolean(),
  })
  .superRefine((value, context) => {
    const expectedKind = value.providerId.endsWith('_api') ? 'api' : 'cli';
    if (value.kind !== expectedKind) {
      context.addIssue({
        code: 'custom',
        path: ['kind'],
        message: '제공자 종류가 ID와 일치하지 않습니다.',
      });
    }
    if (value.kind === 'api' && value.credentialScope !== 'not_applicable') {
      context.addIssue({
        code: 'custom',
        path: ['credentialScope'],
        message: 'API 제공자의 자격 증명 범위는 해당 없음이어야 합니다.',
      });
    }
    if (
      value.displayName !== PROVIDER_DISPLAY_NAMES[value.providerId] ||
      value.notices.length !== PROVIDER_NOTICES[value.providerId].length ||
      value.notices.some((notice, index) => notice !== PROVIDER_NOTICES[value.providerId][index])
    ) {
      context.addIssue({
        code: 'custom',
        path: ['displayName'],
        message: '제공자 표시명과 안내문은 앱이 관리하는 값과 일치해야 합니다.',
      });
    }
    if (
      value.kind === 'api' &&
      (value.sharedCredentialConsentRequired || value.providerManagedHistory)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['sharedCredentialConsentRequired'],
        message: 'API 제공자에는 CLI 공유 자격 증명 동의가 적용되지 않습니다.',
      });
    }
    if (value.kind === 'cli') {
      if (value.credentialScope === 'not_applicable') {
        context.addIssue({
          code: 'custom',
          path: ['credentialScope'],
          message: 'CLI 제공자에는 자격 증명 범위가 필요합니다.',
        });
      }
      if (value.credentialScope === 'profile_scoped' && value.sharedCredentialConsentRequired) {
        context.addIssue({
          code: 'custom',
          path: ['sharedCredentialConsentRequired'],
          message: '프로필 전용 CLI는 공유 자격 증명 동의를 요구하지 않습니다.',
        });
      }
      if (
        value.credentialScope === 'unknown' &&
        (!UNKNOWN_CLI_STATUSES.includes(value.status as (typeof UNKNOWN_CLI_STATUSES)[number]) ||
          !value.sharedCredentialConsentRequired ||
          value.credentialPresent ||
          value.version !== null ||
          value.reportedModelId !== null)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['credentialScope'],
          message: '확인되지 않은 CLI 자격 증명 범위는 준비 상태가 될 수 없습니다.',
        });
      }
    }
  })
  .readonly();
export type ProviderCardState = z.infer<typeof ProviderCardStateSchema>;

export const PublicProviderDiagnosticSchema = z
  .strictObject({
    providerId: z.enum(AI_PROVIDER_IDS),
    status: ProviderStatusSchema,
    version: SafeSemVerSchema.nullable(),
    selectedModelId: ModelIdSchema.nullable(),
    reportedModelId: ModelIdSchema.nullable(),
    credentialPresent: z.boolean(),
    checkedAt: IsoDateTimeSchema.nullable(),
    latencyMs: z.int().min(0).nullable(),
    errorCode: ProviderErrorCodeSchema.nullable(),
    credentialScope: z.enum(CREDENTIAL_SCOPES),
    providerManagedHistory: z.boolean(),
    bindingSha256: Sha256Schema.nullable(),
  })
  .readonly();
export type PublicProviderDiagnostic = z.infer<typeof PublicProviderDiagnosticSchema>;

type ProviderDiagnosticForPublicConversion = Readonly<{
  providerId: AiProviderId;
  status: ProviderStatus;
  version: SafeSemVer | null;
  selectedModelId: string | null;
  reportedModelId: string | null;
  credentialPresent: boolean;
  checkedAt: string | null;
  latencyMs: number | null;
  errorCode: ProviderErrorCode | null;
  credentialScope: CredentialScope;
  providerManagedHistory: boolean;
  cliBinding: Readonly<{ bindingSha256: string }> | null;
}>;

export const toPublicProviderDiagnostic = (
  diagnostic: ProviderDiagnosticForPublicConversion,
): PublicProviderDiagnostic =>
  Object.freeze(
    PublicProviderDiagnosticSchema.parse({
      providerId: diagnostic.providerId,
      status: diagnostic.status,
      version: diagnostic.version,
      selectedModelId: diagnostic.selectedModelId,
      reportedModelId: diagnostic.reportedModelId,
      credentialPresent: diagnostic.credentialPresent,
      checkedAt: diagnostic.checkedAt,
      latencyMs: diagnostic.latencyMs,
      errorCode: diagnostic.errorCode,
      credentialScope: diagnostic.credentialScope,
      providerManagedHistory: diagnostic.providerManagedHistory,
      bindingSha256: diagnostic.cliBinding?.bindingSha256 ?? null,
    }),
  );

export const ProviderSettingsStateSchema = z
  .strictObject({
    routes: z.array(ProviderRouteSchema).max(AI_FEATURES.length).readonly(),
    providers: z.array(ProviderCardStateSchema).max(AI_PROVIDER_IDS.length).readonly(),
  })
  .readonly();
export type ProviderSettingsState = z.infer<typeof ProviderSettingsStateSchema>;

export const SaveProviderRouteRequestSchema = z
  .strictObject({
    feature: z.enum(AI_FEATURES),
    providerId: z.enum(AI_PROVIDER_IDS).nullable(),
    modelId: ModelIdSchema.nullable(),
    enabled: z.boolean(),
    expectedRevision: RevisionSchema,
    confirmNotReady: z.boolean(),
    confirmProviderManagedHistory: z.boolean(),
  })
  .superRefine((value, context) => {
    const apiProvider = value.providerId?.endsWith('_api') === true;
    if (value.enabled && value.providerId === null) {
      context.addIssue({
        code: 'custom',
        path: ['providerId'],
        message: '활성 경로에는 AI 제공자가 필요합니다.',
      });
    }
    if (value.providerId === null && value.modelId !== null) {
      context.addIssue({
        code: 'custom',
        path: ['modelId'],
        message: 'AI 제공자 없이 모델만 선택할 수 없습니다.',
      });
    }
    if (apiProvider && value.modelId === null) {
      context.addIssue({
        code: 'custom',
        path: ['modelId'],
        message: 'API 경로에는 모델 선택이 필요합니다.',
      });
    }
  });
export type SaveProviderRouteRequest = z.infer<typeof SaveProviderRouteRequestSchema>;

export const SaveProviderSecretRequestSchema = z
  .strictObject({
    providerId: z.enum(API_PROVIDER_IDS),
    secret: z.string().regex(/^[\x21-\x7E]{1,8192}$/u),
  })
  .readonly();
export type SaveProviderSecretRequest = z.infer<typeof SaveProviderSecretRequestSchema>;

export const ProviderIdRequestSchema = z
  .strictObject({ providerId: z.enum(AI_PROVIDER_IDS) })
  .readonly();
export type ProviderIdRequest = z.infer<typeof ProviderIdRequestSchema>;
export const ApiProviderIdRequestSchema = z
  .strictObject({ providerId: z.enum(API_PROVIDER_IDS) })
  .readonly();
export type ApiProviderIdRequest = z.infer<typeof ApiProviderIdRequestSchema>;
export const CliProviderIdRequestSchema = z
  .strictObject({ providerId: z.enum(CLI_PROVIDER_IDS) })
  .readonly();
export type CliProviderIdRequest = z.infer<typeof CliProviderIdRequestSchema>;

export const ProbeProviderRequestSchema = z
  .strictObject({
    providerId: z.enum(AI_PROVIDER_IDS),
    modelId: ModelIdSchema.nullable(),
    confirmSharedCredentialUse: z.boolean(),
  })
  .superRefine((value, context) => {
    if (value.providerId.endsWith('_api') && value.modelId === null) {
      context.addIssue({
        code: 'custom',
        path: ['modelId'],
        message: 'API 연결 테스트에는 모델 선택이 필요합니다.',
      });
    }
  })
  .readonly();
export type ProbeProviderRequest = z.infer<typeof ProbeProviderRequestSchema>;

export const OpenProviderLoginRequestSchema = z
  .strictObject({
    providerId: z.enum(CLI_PROVIDER_IDS),
    confirmSharedCredentialMutation: z.boolean(),
  })
  .readonly();
export type OpenProviderLoginRequest = z.infer<typeof OpenProviderLoginRequestSchema>;

export const ProviderHelpRequestSchema = z
  .strictObject({
    providerId: z.enum(AI_PROVIDER_IDS),
    topic: z.enum(['setup', 'data_policy']),
  })
  .readonly();
export type ProviderHelpRequest = z.infer<typeof ProviderHelpRequestSchema>;

const createDefaultRoute = (feature: AiFeature, providerId: AiProviderId | null): ProviderRoute =>
  Object.freeze({
    feature,
    providerId,
    modelId: null,
    promptVersion: DEFAULT_PROMPT_VERSION_BY_FEATURE[feature],
    enabled: false,
    providerManagedHistoryConsentAt: null,
    providerManagedHistoryConsentVersion: null,
    updatedAt: '1970-01-01T00:00:00.000Z',
    revision: 0,
  });

export const DEFAULT_PROVIDER_ROUTES: Readonly<Record<AiFeature, ProviderRoute>> = Object.freeze({
  content_classification: createDefaultRoute('content_classification', null),
  media_extraction: createDefaultRoute('media_extraction', null),
  topic_clustering: createDefaultRoute('topic_clustering', null),
  source_question_extraction: createDefaultRoute('source_question_extraction', null),
  question_variation: createDefaultRoute('question_variation', null),
  course_question_answer: createDefaultRoute('course_question_answer', null),
  audio_transcription: createDefaultRoute('audio_transcription', null),
  document_recognition: createDefaultRoute('document_recognition', null),
  core_summary: createDefaultRoute('core_summary', null),
  lecture_organize: createDefaultRoute('lecture_organize', 'antigravity_cli'),
  lecture_verify: createDefaultRoute('lecture_verify', null),
  professor_profile: createDefaultRoute('professor_profile', 'antigravity_cli'),
  exam_synthesis: createDefaultRoute('exam_synthesis', 'antigravity_cli'),
  question_generation: createDefaultRoute('question_generation', 'antigravity_cli'),
  answer_verification: createDefaultRoute('answer_verification', null),
  grading_feedback: createDefaultRoute('grading_feedback', 'antigravity_cli'),
});

export const FEATURE_DATA_DISCLOSURES: Readonly<Record<AiFeature, string>> = Object.freeze({
  content_classification:
    '이 기능에 선택한 원본 자료와 근거 및 사용자 지시를 AI 제공자에게 전송합니다.',
  media_extraction: '이 기능에 선택한 원본 자료와 근거 및 사용자 지시를 AI 제공자에게 전송합니다.',
  topic_clustering: '이 기능에 선택한 원본 자료와 근거 및 사용자 지시를 AI 제공자에게 전송합니다.',
  source_question_extraction:
    '이 기능에 선택한 원본 자료와 근거 및 사용자 지시를 AI 제공자에게 전송합니다.',
  question_variation:
    '이 기능에 선택한 원본 자료와 근거 및 사용자 지시를 AI 제공자에게 전송합니다.',
  course_question_answer:
    '이 기능에 선택한 원본 자료와 근거 및 사용자 지시를 AI 제공자에게 전송합니다.',
  audio_transcription:
    '이 기능에 선택한 원본 자료와 근거 및 사용자 지시를 AI 제공자에게 전송합니다.',
  document_recognition:
    '이 기능에 선택한 원본 자료와 근거 및 사용자 지시를 AI 제공자에게 전송합니다.',
  core_summary: '이 기능에 선택한 원본 자료와 근거 및 사용자 지시를 AI 제공자에게 전송합니다.',
  lecture_organize: '강의 전사문과 학습 노트를 AI 제공자에게 전송합니다.',
  lecture_verify: '초안 검증 자료와 강의 전사문 일부를 AI 제공자에게 전송합니다.',
  professor_profile: '교수 관찰 메모와 강의 전사문을 AI 제공자에게 전송합니다.',
  exam_synthesis: '시험 종합을 위한 강의 노트와 교수 관찰 자료를 AI 제공자에게 전송합니다.',
  question_generation:
    '문항과 채점 기준 생성을 위한 강의 노트 및 루브릭을 AI 제공자에게 전송합니다.',
  answer_verification: '사용자 답안과 정답 검증 자료를 AI 제공자에게 전송합니다.',
  grading_feedback: '사용자 답안과 생성된 문항 및 루브릭을 AI 제공자에게 전송합니다.',
});

export const PROVIDER_DISPLAY_NAMES: Readonly<Record<AiProviderId, string>> = Object.freeze({
  antigravity_cli: 'Antigravity CLI',
  gemini_cli: 'Gemini CLI',
  codex_cli: 'Codex CLI',
  gemini_api: 'Gemini API',
  openai_api: 'OpenAI API',
  claude_api: 'Claude API',
});

export const PROVIDER_NOTICES: Readonly<Record<AiProviderId, readonly string[]>> = Object.freeze({
  antigravity_cli: Object.freeze([
    '제공자 관리 기록 보존 가능성을 확인하고 명시적으로 동의해야 합니다.',
  ]),
  gemini_cli: Object.freeze([
    'Google AI 개인 구독과 Gemini API 키는 별도입니다.',
    'Gemini CLI 0.55.1의 유효 정책·컨텍스트 격리·인증 경로·기록 보존 조건이 확인되지 않아 텍스트와 원본 파일 실행이 차단되어 있습니다. API 경로는 별도로 설정해야 합니다.',
  ]),
  codex_cli: Object.freeze(['Codex CLI 로그인과 OpenAI API 키·과금은 별도입니다.']),
  gemini_api: Object.freeze(['API 키는 운영체제 보안 저장소에만 저장합니다.']),
  openai_api: Object.freeze(['API 키는 운영체제 보안 저장소에만 저장합니다.']),
  claude_api: Object.freeze(['API 키는 운영체제 보안 저장소에만 저장합니다.']),
});

export const isProviderErrorCode = (code: AppErrorCode): code is ProviderErrorCode =>
  code.startsWith('PROVIDER_');
