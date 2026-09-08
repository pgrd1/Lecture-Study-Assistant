import { z } from 'zod';

export const APP_ERROR_MESSAGES = Object.freeze({
  PROVIDER_MEDIA_UNSUPPORTED: '선택한 AI 경로는 이 자료 형식을 지원하지 않습니다.',
  ATTACHMENT_HASH_MISMATCH: '복사된 첨부 파일의 무결성을 확인하지 못했습니다.',
  COURSE_NOT_FOUND: '과목을 찾지 못했습니다.',
  DATABASE_BUSY: '로컬 데이터베이스가 사용 중입니다. 잠시 후 다시 시도해 주세요.',
  DATABASE_ERROR: '로컬 데이터베이스 작업에 실패했습니다.',
  DATABASE_MIGRATION_FAILED: '로컬 데이터베이스를 업데이트하지 못했습니다.',
  DIAGNOSTICS_EXPORT_FAILED: '진단 보고서를 안전하게 내보내지 못했습니다.',
  DUPLICATE_COURSE: '같은 노트 폴더를 사용하는 과목이 이미 있습니다.',
  DUPLICATE_JOB: '이미 등록된 강의 자료입니다.',
  EXTERNAL_LINK_FAILED: '공식 도움말 페이지를 열지 못했습니다.',
  INVALID_COURSE: '과목명과 교수 표시명을 확인해 주세요.',
  INVALID_COURSE_PATCH: '변경할 과목 정보를 확인해 주세요.',
  INVALID_FINGERPRINT: '중복 검사 값을 확인해 주세요.',
  INVALID_INPUT: '입력 내용을 확인해 주세요.',
  INVALID_JOB_TRANSITION: '허용되지 않는 작업 상태 변경입니다.',
  INVALID_QUEUE_ITEM: 'iCloud 대기열 항목 형식을 확인해 주세요.',
  QUEUE_ITEM_NOT_STABLE: 'iCloud 파일 동기화가 완료될 때까지 잠시 기다려 주세요.',
  QUEUE_CONNECTION_FAILED: 'iCloud 대기열 연결을 확인해 주세요.',
  QUEUE_WRITE_FAILED: 'iCloud 대기열에 안전하게 저장하지 못했습니다.',
  PROVIDER_ACCOUNT_UNSUPPORTED: '현재 계정은 이 AI 제공자 연결을 지원하지 않습니다.',
  PROVIDER_AUTH_REQUIRED: 'AI 제공자 인증이 필요합니다.',
  PROVIDER_BUSY: 'AI 제공자가 현재 다른 요청을 처리하고 있습니다.',
  PROVIDER_CANCELLED: 'AI 제공자 요청이 취소되었습니다.',
  PROVIDER_CLI_CHANGED: '확인한 AI CLI 실행 파일이 변경되었습니다.',
  PROVIDER_DATA_RETENTION_CONSENT_REQUIRED: '제공자 기록 보존 고지에 동의해야 합니다.',
  PROVIDER_EXECUTABLE_NOT_FOUND: 'AI CLI 실행 파일을 찾지 못했습니다.',
  PROVIDER_EXECUTION_FAILED: 'AI 제공자 요청을 완료하지 못했습니다.',
  PROVIDER_LOGIN_TERMINAL_UNAVAILABLE: 'AI 제공자 로그인 터미널을 열 수 없습니다.',
  PROVIDER_MODEL_INCOMPATIBLE: '선택한 AI 모델은 요청 형식을 지원하지 않습니다.',
  PROVIDER_NETWORK_FAILED: 'AI 제공자 네트워크 연결에 실패했습니다.',
  PROVIDER_NOT_CONFIGURED: '이 기능에 AI 제공자가 설정되지 않았습니다.',
  PROVIDER_NOT_READY: 'AI 제공자 연결을 먼저 확인해 주세요.',
  PROVIDER_OUTPUT_INVALID: 'AI 제공자 응답 형식을 확인하지 못했습니다.',
  PROVIDER_QUOTA_OR_BILLING: 'AI 제공자 사용량 또는 결제 상태를 확인해 주세요.',
  PROVIDER_RATE_LIMITED: 'AI 제공자 요청 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.',
  PROVIDER_REFUSED: 'AI 제공자가 요청 처리를 거부했습니다.',
  PROVIDER_REQUEST_TOO_LARGE: 'AI 제공자 요청이 허용된 크기를 초과했습니다.',
  PROVIDER_RESIDUAL_DATA: 'AI CLI의 임시 데이터 정리를 확인하지 못했습니다.',
  PROVIDER_RESPONSE_TOO_LARGE: 'AI 제공자 응답이 허용된 크기를 초과했습니다.',
  PROVIDER_SHARED_CREDENTIAL_CONSENT_REQUIRED: '공유 AI 로그인 사용에 동의해야 합니다.',
  PROVIDER_SHARED_CREDENTIAL_MUTATION_BLOCKED: '공유 AI 로그인은 앱에서 변경할 수 없습니다.',
  PROVIDER_TEMPORARILY_UNAVAILABLE: 'AI 제공자를 일시적으로 사용할 수 없습니다.',
  PROVIDER_TIMEOUT: 'AI 제공자 응답 시간이 초과되었습니다.',
  PROVIDER_TOOL_ACTIVITY_DETECTED: 'AI CLI가 허용되지 않은 도구 활동을 시도했습니다.',
  PROVIDER_UNSAFE_VERSION: 'AI CLI 버전의 안전 조건을 확인하지 못했습니다.',
  SECURE_STORAGE_UNAVAILABLE: '운영체제 보안 저장소를 사용할 수 없습니다.',
  SECRET_STORAGE_FAILED: 'API 키 보안 저장소를 읽거나 쓰지 못했습니다.',
  SAFE_PATH: '안전하지 않은 경로입니다.',
  SOURCE_COPY_FAILED: '원본을 복사하지 못했습니다.',
  SOURCE_HASH_CANCELLED: '원본 파일 무결성 확인이 취소되었습니다.',
  SOURCE_HASH_FAILED: '원본 파일의 무결성을 확인하지 못했습니다.',
  SOURCE_HASH_MISMATCH: '원본 파일의 무결성 값이 일치하지 않습니다.',
  SOURCE_TOO_LARGE: '원본 파일이 허용된 크기를 초과했습니다.',
  STALE_WRITE: '다른 변경 사항이 먼저 저장되었습니다. 새로고침 후 다시 시도해 주세요.',
  UNEXPECTED_ERROR: '예상하지 못한 오류가 발생했습니다.',
  UNTRUSTED_IPC_SENDER: '허용되지 않은 화면 요청입니다.',
  VAULT_CONNECTION_FAILED: 'Obsidian Vault 연결을 확인해 주세요.',
  VAULT_WRITE_FAILED: 'Obsidian Vault에 안전하게 저장하지 못했습니다.',
} as const);

export const APP_ERROR_CODES = [
  'PROVIDER_MEDIA_UNSUPPORTED',
  'ATTACHMENT_HASH_MISMATCH',
  'COURSE_NOT_FOUND',
  'DATABASE_BUSY',
  'DATABASE_ERROR',
  'DATABASE_MIGRATION_FAILED',
  'DIAGNOSTICS_EXPORT_FAILED',
  'DUPLICATE_COURSE',
  'DUPLICATE_JOB',
  'EXTERNAL_LINK_FAILED',
  'INVALID_COURSE',
  'INVALID_COURSE_PATCH',
  'INVALID_FINGERPRINT',
  'INVALID_INPUT',
  'INVALID_JOB_TRANSITION',
  'INVALID_QUEUE_ITEM',
  'QUEUE_ITEM_NOT_STABLE',
  'QUEUE_CONNECTION_FAILED',
  'QUEUE_WRITE_FAILED',
  'PROVIDER_ACCOUNT_UNSUPPORTED',
  'PROVIDER_AUTH_REQUIRED',
  'PROVIDER_BUSY',
  'PROVIDER_CANCELLED',
  'PROVIDER_CLI_CHANGED',
  'PROVIDER_DATA_RETENTION_CONSENT_REQUIRED',
  'PROVIDER_EXECUTABLE_NOT_FOUND',
  'PROVIDER_EXECUTION_FAILED',
  'PROVIDER_LOGIN_TERMINAL_UNAVAILABLE',
  'PROVIDER_MODEL_INCOMPATIBLE',
  'PROVIDER_NETWORK_FAILED',
  'PROVIDER_NOT_CONFIGURED',
  'PROVIDER_NOT_READY',
  'PROVIDER_OUTPUT_INVALID',
  'PROVIDER_QUOTA_OR_BILLING',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_REFUSED',
  'PROVIDER_REQUEST_TOO_LARGE',
  'PROVIDER_RESIDUAL_DATA',
  'PROVIDER_RESPONSE_TOO_LARGE',
  'PROVIDER_SHARED_CREDENTIAL_CONSENT_REQUIRED',
  'PROVIDER_SHARED_CREDENTIAL_MUTATION_BLOCKED',
  'PROVIDER_TEMPORARILY_UNAVAILABLE',
  'PROVIDER_TIMEOUT',
  'PROVIDER_TOOL_ACTIVITY_DETECTED',
  'PROVIDER_UNSAFE_VERSION',
  'SECURE_STORAGE_UNAVAILABLE',
  'SECRET_STORAGE_FAILED',
  'SAFE_PATH',
  'SOURCE_COPY_FAILED',
  'SOURCE_HASH_CANCELLED',
  'SOURCE_HASH_FAILED',
  'SOURCE_HASH_MISMATCH',
  'SOURCE_TOO_LARGE',
  'STALE_WRITE',
  'UNEXPECTED_ERROR',
  'UNTRUSTED_IPC_SENDER',
  'VAULT_CONNECTION_FAILED',
  'VAULT_WRITE_FAILED',
] as const;

export const AppErrorCodeSchema = z.enum(APP_ERROR_CODES);
export type AppErrorCode = z.infer<typeof AppErrorCodeSchema>;

export const APP_ERROR_RETRY_POLICY = Object.freeze({
  PROVIDER_MEDIA_UNSUPPORTED: false,
  ATTACHMENT_HASH_MISMATCH: false,
  COURSE_NOT_FOUND: false,
  DATABASE_BUSY: true,
  DATABASE_ERROR: false,
  DATABASE_MIGRATION_FAILED: false,
  DIAGNOSTICS_EXPORT_FAILED: true,
  DUPLICATE_COURSE: false,
  DUPLICATE_JOB: false,
  EXTERNAL_LINK_FAILED: true,
  INVALID_COURSE: false,
  INVALID_COURSE_PATCH: false,
  INVALID_FINGERPRINT: false,
  INVALID_INPUT: false,
  INVALID_JOB_TRANSITION: false,
  INVALID_QUEUE_ITEM: false,
  QUEUE_ITEM_NOT_STABLE: true,
  QUEUE_CONNECTION_FAILED: false,
  QUEUE_WRITE_FAILED: true,
  PROVIDER_ACCOUNT_UNSUPPORTED: false,
  PROVIDER_AUTH_REQUIRED: false,
  PROVIDER_BUSY: true,
  PROVIDER_CANCELLED: false,
  PROVIDER_CLI_CHANGED: false,
  PROVIDER_DATA_RETENTION_CONSENT_REQUIRED: false,
  PROVIDER_EXECUTABLE_NOT_FOUND: false,
  PROVIDER_EXECUTION_FAILED: false,
  PROVIDER_LOGIN_TERMINAL_UNAVAILABLE: false,
  PROVIDER_MODEL_INCOMPATIBLE: false,
  PROVIDER_NETWORK_FAILED: true,
  PROVIDER_NOT_CONFIGURED: false,
  PROVIDER_NOT_READY: false,
  PROVIDER_OUTPUT_INVALID: false,
  PROVIDER_QUOTA_OR_BILLING: false,
  PROVIDER_RATE_LIMITED: true,
  PROVIDER_REFUSED: false,
  PROVIDER_REQUEST_TOO_LARGE: false,
  PROVIDER_RESIDUAL_DATA: false,
  PROVIDER_RESPONSE_TOO_LARGE: false,
  PROVIDER_SHARED_CREDENTIAL_CONSENT_REQUIRED: false,
  PROVIDER_SHARED_CREDENTIAL_MUTATION_BLOCKED: false,
  PROVIDER_TEMPORARILY_UNAVAILABLE: true,
  PROVIDER_TIMEOUT: true,
  PROVIDER_TOOL_ACTIVITY_DETECTED: false,
  PROVIDER_UNSAFE_VERSION: false,
  SECURE_STORAGE_UNAVAILABLE: false,
  SECRET_STORAGE_FAILED: false,
  SAFE_PATH: false,
  SOURCE_COPY_FAILED: true,
  SOURCE_HASH_CANCELLED: false,
  SOURCE_HASH_FAILED: true,
  SOURCE_HASH_MISMATCH: false,
  SOURCE_TOO_LARGE: false,
  STALE_WRITE: false,
  UNEXPECTED_ERROR: false,
  UNTRUSTED_IPC_SENDER: false,
  VAULT_CONNECTION_FAILED: false,
  VAULT_WRITE_FAILED: true,
} as const satisfies Record<AppErrorCode, boolean>);

export const PROVIDER_ERROR_CODES = Object.freeze([
  'PROVIDER_MEDIA_UNSUPPORTED',
  'PROVIDER_ACCOUNT_UNSUPPORTED',
  'PROVIDER_AUTH_REQUIRED',
  'PROVIDER_BUSY',
  'PROVIDER_CANCELLED',
  'PROVIDER_CLI_CHANGED',
  'PROVIDER_DATA_RETENTION_CONSENT_REQUIRED',
  'PROVIDER_EXECUTABLE_NOT_FOUND',
  'PROVIDER_EXECUTION_FAILED',
  'PROVIDER_LOGIN_TERMINAL_UNAVAILABLE',
  'PROVIDER_MODEL_INCOMPATIBLE',
  'PROVIDER_NETWORK_FAILED',
  'PROVIDER_NOT_CONFIGURED',
  'PROVIDER_NOT_READY',
  'PROVIDER_OUTPUT_INVALID',
  'PROVIDER_QUOTA_OR_BILLING',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_REFUSED',
  'PROVIDER_REQUEST_TOO_LARGE',
  'PROVIDER_RESIDUAL_DATA',
  'PROVIDER_RESPONSE_TOO_LARGE',
  'PROVIDER_SHARED_CREDENTIAL_CONSENT_REQUIRED',
  'PROVIDER_SHARED_CREDENTIAL_MUTATION_BLOCKED',
  'PROVIDER_TEMPORARILY_UNAVAILABLE',
  'PROVIDER_TIMEOUT',
  'PROVIDER_TOOL_ACTIVITY_DETECTED',
  'PROVIDER_UNSAFE_VERSION',
] as const);
export const ProviderErrorCodeSchema = z.enum(PROVIDER_ERROR_CODES);
export type ProviderErrorCode = z.infer<typeof ProviderErrorCodeSchema>;

export const ErrorEnvelopeSchema = z
  .strictObject({
    code: AppErrorCodeSchema,
    message: z.string().min(1).max(240),
    retryable: z.boolean(),
  })
  .superRefine((envelope, context) => {
    if (envelope.message !== APP_ERROR_MESSAGES[envelope.code]) {
      context.addIssue({
        code: 'custom',
        message: '오류 코드와 사용자 메시지가 일치하지 않습니다.',
        path: ['message'],
      });
    }
    if (envelope.retryable !== APP_ERROR_RETRY_POLICY[envelope.code]) {
      context.addIssue({
        code: 'custom',
        message: '오류 코드와 재시도 정책이 일치하지 않습니다.',
        path: ['retryable'],
      });
    }
  })
  .readonly();

export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

type AppErrorOptions = Readonly<{
  retryable?: boolean;
  recoveryToken?: string;
  backupRecoveryToken?: string;
  retryAfterMs?: number | null;
}>;

const RECOVERY_TOKEN = /^[A-Za-z0-9._-]{1,160}$/u;
const MAX_APP_ERROR_RETRY_AFTER_MS = 5_000;

export class AppError extends Error {
  readonly #backupRecoveryToken: string | undefined;
  readonly #recoveryToken: string | undefined;
  readonly #retryAfterMs: number | null;
  readonly #trusted = true;
  readonly code: AppErrorCode;
  readonly displayMessage: string;
  readonly retryable: boolean;

  constructor(code: AppErrorCode, displayMessage: string, options: AppErrorOptions = {}) {
    const parsedCode = AppErrorCodeSchema.safeParse(code);
    if (!parsedCode.success) {
      throw new TypeError('INVALID_APP_ERROR_CODE');
    }
    if (displayMessage !== APP_ERROR_MESSAGES[parsedCode.data]) {
      throw new TypeError('INVALID_APP_ERROR_MESSAGE');
    }
    const retryable = APP_ERROR_RETRY_POLICY[parsedCode.data];
    if (options.retryable !== undefined && options.retryable !== retryable) {
      throw new TypeError('INVALID_APP_ERROR_RETRY_POLICY');
    }
    if (options.recoveryToken !== undefined && !RECOVERY_TOKEN.test(options.recoveryToken)) {
      throw new TypeError('INVALID_APP_ERROR_RECOVERY_TOKEN');
    }
    if (
      options.backupRecoveryToken !== undefined &&
      !RECOVERY_TOKEN.test(options.backupRecoveryToken)
    ) {
      throw new TypeError('INVALID_APP_ERROR_BACKUP_RECOVERY_TOKEN');
    }
    if (
      options.retryAfterMs !== undefined &&
      options.retryAfterMs !== null &&
      (!Number.isSafeInteger(options.retryAfterMs) || options.retryAfterMs < 0)
    ) {
      throw new TypeError('INVALID_APP_ERROR_RETRY_AFTER');
    }

    super(code);
    this.name = 'AppError';
    this.code = parsedCode.data;
    this.displayMessage = APP_ERROR_MESSAGES[parsedCode.data];
    this.retryable = retryable;
    this.#recoveryToken = options.recoveryToken;
    this.#backupRecoveryToken = options.backupRecoveryToken;
    this.#retryAfterMs =
      options.retryAfterMs === undefined || options.retryAfterMs === null
        ? null
        : Math.min(options.retryAfterMs, MAX_APP_ERROR_RETRY_AFTER_MS);
    Object.freeze(this);
  }

  get recoveryToken(): string | undefined {
    return this.#recoveryToken;
  }

  get backupRecoveryToken(): string | undefined {
    return this.#backupRecoveryToken;
  }

  static isTrusted(error: unknown): error is AppError {
    try {
      return error instanceof AppError && error.#trusted === true;
    } catch {
      return false;
    }
  }

  static getRetryAfterMs(error: unknown): number | null {
    try {
      return error instanceof AppError && error.#trusted === true ? error.#retryAfterMs : null;
    } catch {
      return null;
    }
  }
}

export const toErrorEnvelope = (error: unknown): ErrorEnvelope => {
  if (AppError.isTrusted(error)) {
    const envelope = ErrorEnvelopeSchema.safeParse({
      code: error.code,
      message: error.displayMessage,
      retryable: error.retryable,
    });
    if (envelope.success) {
      return envelope.data;
    }
  }

  return ErrorEnvelopeSchema.parse({
    code: 'UNEXPECTED_ERROR',
    message: APP_ERROR_MESSAGES.UNEXPECTED_ERROR,
    retryable: false,
  });
};
