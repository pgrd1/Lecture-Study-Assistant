const PROTOCOL_VERSION = 1;
const SOURCE_BUNDLE_PROTOCOL_VERSION = 2;
const MAX_SOURCES_PER_BUNDLE = 32;
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_AUDIO_VIDEO_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_DOCUMENT_IMAGE_BYTES = 500 * 1024 * 1024;
const MAX_CATALOG_BYTES = 256 * 1024;
const MAX_COURSE_REQUEST_BYTES = 64 * 1024;
const MAX_COURSE_INBOX_ENTRIES = 1000;
const MAX_OWNER_MARKER_BYTES = 1024;
const MAX_STATUS_RECEIPT_BYTES = 64 * 1024;
const MAX_STATUS_DIRECTORY_ENTRIES = 1000;
const WHOLE_KILOBYTE_BYTES = 1024;
const OWNER_MARKER_PATH = '.lecture-study-assistant-root.json';
const OWNER_MARKER = Object.freeze({
  schemaVersion: 1,
  owner: 'lecture-study-assistant',
  queueProtocolVersion: 1,
});
const RESERVED_DIRECTORIES = Object.freeze([
  'Catalog',
  'Inbox',
  'CourseInbox',
  'Status',
  'Rejected',
]);
const QUEUE_DIAGNOSTIC_BUILD = '20260905-2';
const INVOCATION_DIAGNOSTIC_BUILD = '20260905-3';
const RUNTIME_DIAGNOSTIC_BUILD = '20260906-4';
const RUNTIME_DIAGNOSTIC_STAGES = Object.freeze([
  'E01',
  'F01',
  'F02',
  'U01',
  'U02',
  'U11',
  'U12',
  'U13',
  'U111',
  'U112',
  'U113',
]);
const QUEUE_DIAGNOSTIC_STAGES = Object.freeze([
  'R00',
  'R01',
  'R02',
  'R03',
  'R04',
  'R05',
  'R06',
  'R07',
  'R08',
  'R09',
  'R10',
  'R11',
  'R12',
  'R13',
  'R14',
  'R15',
  'R16',
  'R17',
  'R18',
]);

const APP_ERROR_MESSAGES = Object.freeze({
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
  PROVIDER_MEDIA_UNSUPPORTED: '선택한 AI 경로는 이 자료 형식을 지원하지 않습니다.',
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
});

const PUBLIC_RESULT_MESSAGES = Object.freeze({
  AMBIGUOUS_INPUT: '단축어 입력을 구분할 수 없습니다. 파일을 하나만 다시 보내 주세요.',
  CATALOG_INVALID: '과목 목록을 확인할 수 없습니다.',
  COURSE_SELECTION_STALE: '과목 목록이 변경되었습니다. 다시 선택해 주세요.',
  INVALID_COURSE: APP_ERROR_MESSAGES.INVALID_COURSE,
  INVALID_ACTION: '단축어 입력을 확인해 주세요.',
  INVALID_INPUT: '입력 내용을 확인해 주세요.',
  FILE_TOO_LARGE: '선택한 파일 묶음이 허용된 전체 크기를 초과했습니다.',
  MULTIPLE_FILES: '파일은 한 번에 하나만 보내 주세요.',
  QUEUE_WRITE_FAILED: 'iCloud 대기열에 안전하게 저장하지 못했습니다.',
  QUEUE_ROOT_CONFLICT: 'Scriptable 폴더에 같은 이름의 기존 데이터가 있어 자동 설정을 중단했습니다.',
  SHORTCUT_ONLY: '이 스크립트는 강의 학습 도우미 단축어에서 실행해 주세요.',
  SOURCE_COPY_FAILED: '원본을 복사하지 못했습니다.',
  SOURCE_TOO_LARGE: '원본 파일이 허용된 크기를 초과했습니다.',
  STATUS_READ_PARTIAL: '일부 상태 파일을 확인할 수 없습니다. Windows 앱에서 진단해 주세요.',
  UNSUPPORTED_SOURCE: '지원하지 않는 파일 형식입니다.',
  UNEXPECTED_ERROR: '예상하지 못한 오류가 발생했습니다. 다시 시도해 주세요.',
});

const PUBLIC_STATUS_MESSAGES = Object.freeze({
  completed: '강의 자료 정리가 완료되었습니다.',
  processing: '강의 자료를 처리하고 있습니다.',
  queued: '강의 자료가 안전하게 대기 중입니다.',
});

const ADD_COURSE_LABEL = '＋ 과목 추가';

const MEDIA_TYPES = Object.freeze({
  '.aac': 'audio',
  '.flac': 'audio',
  '.heic': 'image',
  '.jpeg': 'image',
  '.jpg': 'image',
  '.m4a': 'audio',
  '.md': 'document',
  '.mp3': 'audio',
  '.mp4': 'video',
  '.pdf': 'document',
  '.png': 'image',
  '.pptx': 'document',
  '.txt': 'document',
  '.wav': 'audio',
});

const UUID_PATTERN =
  /^(?:00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ISO_WITH_OFFSET_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/u;
const WINDOWS_DEVICE_NAME_PATTERN =
  /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)$/iu;
const WINDOWS_FORBIDDEN = '<>:"/\\|?*';

const frozen = (value) => Object.freeze(value);
const internalFailures = new WeakSet();

const invalid = (code) => {
  const error = new TypeError(code);
  internalFailures.add(error);
  throw error;
};

const internalFailureCode = (error) =>
  error instanceof Error && internalFailures.has(error) ? error.message : null;

const runRuntimeOperation = async (stage, operation) => {
  try {
    return await operation();
  } catch (error) {
    if (internalFailureCode(error) !== null) throw error;
    const safeStage = RUNTIME_DIAGNOSTIC_STAGES.indexOf(stage) === -1 ? 'U01' : stage;
    invalid(`UNEXPECTED_ERROR|${safeStage}`);
  }
};

const runRuntimeOperationSync = (stage, operation) => {
  try {
    return operation();
  } catch (error) {
    if (internalFailureCode(error) !== null) throw error;
    const safeStage = RUNTIME_DIAGNOSTIC_STAGES.indexOf(stage) === -1 ? 'U01' : stage;
    invalid(`UNEXPECTED_ERROR|${safeStage}`);
  }
};

const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const hasExactKeys = (value, keys) => {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = keys.slice().sort();
  if (actual.length !== expected.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index] !== expected[index]) return false;
  }
  return true;
};

const isUuid = (value) => typeof value === 'string' && UUID_PATTERN.test(value);

const isIsoWithOffset = (value) => {
  if (typeof value !== 'string') return false;
  const match = ISO_WITH_OFFSET_PATTERN.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  const maximumDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= maximumDay &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value))
  );
};

const isExactStatusDictionary = (value) =>
  hasExactKeys(value, ['action']) && value.action === 'status';

const isExactCoursesDictionary = (value) =>
  hasExactKeys(value, ['action']) && value.action === 'courses';

const isExactSelectedCourseEnqueueDictionary = (value) =>
  hasExactKeys(value, ['action', 'courseId']) && value.action === 'enqueue';

const isExactNewCourseEnqueueDictionary = (value) =>
  hasExactKeys(value, ['action', 'newCourseName', 'professorName']) && value.action === 'enqueue';

const pathFromFileUrl = (value) => {
  if (typeof value !== 'string' || value.slice(0, 7).toLowerCase() !== 'file://') {
    invalid('INVALID_INPUT');
  }
  const path = value.slice(7);
  if (path.slice(0, 1) !== '/') invalid('INVALID_INPUT');
  try {
    return decodeURIComponent(path);
  } catch (_error) {
    invalid('INVALID_INPUT');
  }
};

const shortcutOnlyResult = () =>
  frozen({
    code: 'SHORTCUT_ONLY',
    message: PUBLIC_RESULT_MESSAGES.SHORTCUT_ONLY,
    ok: false,
  });

const pathFromShortcutFileParameter = (value) => {
  if (typeof value !== 'string' || value.indexOf('\0') !== -1) return null;
  if (value.slice(0, 1) === '/') return value;
  if (value.slice(0, 7).toLowerCase() !== 'file://') return null;
  const path = pathFromFileUrl(value);
  return path.indexOf('\0') === -1 ? path : null;
};

const requiredShortcutFilePath = (value) => {
  const path = pathFromShortcutFileParameter(value);
  if (path === null) invalid('INVALID_INPUT');
  return path;
};

function parseInvocation(input) {
  if (!isPlainObject(input) || !Array.isArray(input.fileURLs)) invalid('INVALID_INPUT');
  const files = input.fileURLs;
  const parameter = input.shortcutParameter;
  const requestsWithoutFiles =
    isExactStatusDictionary(parameter) || isExactCoursesDictionary(parameter);
  if (files.length > 0 && requestsWithoutFiles) {
    invalid('AMBIGUOUS_INPUT');
  }
  if (files.length > MAX_SOURCES_PER_BUNDLE) invalid('INVALID_INPUT');
  if (isExactStatusDictionary(parameter)) return frozen({ action: 'status' });
  if (isExactCoursesDictionary(parameter)) return frozen({ action: 'courses' });
  const sourcePaths = () => {
    const paths = files.map(requiredShortcutFilePath);
    if (new Set(paths).size !== paths.length) invalid('INVALID_INPUT');
    return frozen(paths);
  };
  if (isExactSelectedCourseEnqueueDictionary(parameter)) {
    if (files.length < 1) invalid('INVALID_INPUT');
    if (!isUuid(parameter.courseId)) invalid('INVALID_COURSE');
    return frozen({
      action: 'enqueue',
      courseId: parameter.courseId,
      sourcePaths: sourcePaths(),
    });
  }
  if (isExactNewCourseEnqueueDictionary(parameter)) {
    if (files.length < 1) invalid('INVALID_INPUT');
    if (
      typeof parameter.newCourseName !== 'string' ||
      typeof parameter.professorName !== 'string'
    ) {
      invalid('INVALID_COURSE');
    }
    return frozen({
      action: 'enqueue',
      newCourse: frozen({ name: parameter.newCourseName, professorName: parameter.professorName }),
      sourcePaths: sourcePaths(),
    });
  }
  if (isPlainObject(parameter)) invalid('INVALID_ACTION');
  if (files.length > 0) {
    return frozen({ action: 'enqueue', sourcePaths: sourcePaths() });
  }
  const shortcutFilePath = pathFromShortcutFileParameter(parameter);
  if (shortcutFilePath !== null) {
    return frozen({ action: 'enqueue', sourcePaths: frozen([shortcutFilePath]) });
  }
  if (parameter === null || parameter === undefined) return shortcutOnlyResult();
  invalid('INVALID_ACTION');
}

function validateCourseCatalog(value) {
  if (!hasExactKeys(value, ['protocolVersion', 'generatedAt', 'courses']))
    invalid('INVALID_COURSE_CATALOG');
  if (value.protocolVersion !== PROTOCOL_VERSION || !isIsoWithOffset(value.generatedAt)) {
    invalid('INVALID_COURSE_CATALOG');
  }
  if (!Array.isArray(value.courses)) invalid('INVALID_COURSE_CATALOG');
  const ids = Object.create(null);
  const courses = value.courses.map((course) => {
    if (
      !hasExactKeys(course, ['id', 'name']) ||
      !isUuid(course.id) ||
      typeof course.name !== 'string'
    ) {
      invalid('INVALID_COURSE_CATALOG');
    }
    const name = course.name.trim();
    if (name.length < 1 || name.length > 80 || ids[course.id] === true)
      invalid('INVALID_COURSE_CATALOG');
    ids[course.id] = true;
    return frozen({ id: course.id, name: name });
  });
  return frozen({
    courses: frozen(courses),
    generatedAt: value.generatedAt,
    protocolVersion: PROTOCOL_VERSION,
  });
}

const validateCourseDisplayText = (value, minimumLength, maximumLength) => {
  if (typeof value !== 'string') invalid('INVALID_COURSE');
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029) {
      invalid('INVALID_COURSE');
    }
  }
  const normalized = value.trim();
  if (
    normalized.length < minimumLength ||
    normalized.length > maximumLength ||
    (minimumLength > 0 && !/\S/u.test(normalized))
  ) {
    invalid('INVALID_COURSE');
  }
  return normalized;
};

function validateCourseProvisioningInput(value) {
  if (!hasExactKeys(value, ['id', 'name', 'professorName']) || !isUuid(value.id)) {
    invalid('INVALID_COURSE');
  }
  return frozen({
    id: value.id,
    name: validateCourseDisplayText(value.name, 1, 80),
    professorName: validateCourseDisplayText(value.professorName, 0, 80),
  });
}

const validateQueueRequestSource = (value) => {
  if (
    !hasExactKeys(value, ['fileName', 'mediaType']) ||
    typeof value.fileName !== 'string' ||
    typeof value.mediaType !== 'string'
  ) {
    invalid('INVALID_COURSE_INBOX_REQUEST');
  }
  const extensionIndex = value.fileName.lastIndexOf('.');
  const extension = extensionIndex < 0 ? '' : value.fileName.slice(extensionIndex).toLowerCase();
  const mediaType = mediaTypeForExtension(extension);
  if (mediaType === null || mediaType !== value.mediaType) {
    invalid('INVALID_COURSE_INBOX_REQUEST');
  }
  if (!isWindowsSafeDisplayName(value.fileName, extension)) {
    invalid('INVALID_COURSE_INBOX_REQUEST');
  }
  return frozen({ fileName: value.fileName, mediaType: value.mediaType });
};

function validateCourseInboxRequest(value) {
  if (
    !hasExactKeys(value, [
      'protocolVersion',
      'jobId',
      'createdAt',
      'course',
      'source',
      'summaryMode',
    ]) ||
    value.protocolVersion !== PROTOCOL_VERSION ||
    !isUuid(value.jobId) ||
    !isIsoWithOffset(value.createdAt) ||
    ['none', 'core', 'standard', 'full'].indexOf(value.summaryMode) === -1
  ) {
    invalid('INVALID_COURSE_INBOX_REQUEST');
  }
  let course;
  try {
    course = validateCourseProvisioningInput(value.course);
  } catch (_error) {
    invalid('INVALID_COURSE_INBOX_REQUEST');
  }
  return frozen({
    protocolVersion: PROTOCOL_VERSION,
    jobId: value.jobId,
    createdAt: value.createdAt,
    course: course,
    source: validateQueueRequestSource(value.source),
    summaryMode: value.summaryMode,
  });
}

function validateStatusReceipt(value) {
  if (
    !isPlainObject(value) ||
    !isUuid(value.jobId) ||
    !isUuid(value.courseId) ||
    !isIsoWithOffset(value.updatedAt)
  ) {
    invalid('INVALID_STATUS_RECEIPT');
  }
  const common = {
    courseId: value.courseId,
    displayMessage: value.displayMessage,
    jobId: value.jobId,
    status: value.status,
    updatedAt: value.updatedAt,
  };
  if (value.status === 'failed') {
    if (
      !hasExactKeys(value, [
        'jobId',
        'courseId',
        'updatedAt',
        'status',
        'displayMessage',
        'errorCode',
      ])
    ) {
      invalid('INVALID_STATUS_RECEIPT');
    }
    if (
      typeof value.errorCode !== 'string' ||
      value.displayMessage !== APP_ERROR_MESSAGES[value.errorCode]
    ) {
      invalid('INVALID_STATUS_RECEIPT');
    }
    return frozen({
      courseId: common.courseId,
      displayMessage: common.displayMessage,
      errorCode: value.errorCode,
      jobId: common.jobId,
      status: 'failed',
      updatedAt: common.updatedAt,
    });
  }
  if (value.status !== 'queued' && value.status !== 'processing' && value.status !== 'completed') {
    invalid('INVALID_STATUS_RECEIPT');
  }
  if (!hasExactKeys(value, ['jobId', 'courseId', 'updatedAt', 'status', 'displayMessage'])) {
    invalid('INVALID_STATUS_RECEIPT');
  }
  if (value.displayMessage !== PUBLIC_STATUS_MESSAGES[value.status])
    invalid('INVALID_STATUS_RECEIPT');
  return frozen({
    courseId: common.courseId,
    displayMessage: common.displayMessage,
    jobId: common.jobId,
    status: common.status,
    updatedAt: common.updatedAt,
  });
}

const validateRejectionReceipt = (value) => {
  if (
    !hasExactKeys(value, ['jobId', 'status', 'displayMessage', 'updatedAt', 'errorCode']) ||
    !isUuid(value.jobId) ||
    value.status !== 'failed' ||
    !isIsoWithOffset(value.updatedAt) ||
    typeof value.errorCode !== 'string' ||
    value.displayMessage !== APP_ERROR_MESSAGES[value.errorCode]
  ) {
    invalid('INVALID_REJECTION_RECEIPT');
  }
  return frozen({
    jobId: value.jobId,
    status: 'failed',
    displayMessage: value.displayMessage,
    updatedAt: value.updatedAt,
    errorCode: value.errorCode,
  });
};

function mediaTypeForExtension(extension) {
  if (typeof extension !== 'string') return null;
  return MEDIA_TYPES[extension.toLowerCase()] || null;
}

const isWindowsSafeDisplayName = (fileName, extension) => {
  if (typeof fileName !== 'string' || fileName.length < 1 || fileName.length > 180) return false;
  if (fileName.slice(-1) === '.' || fileName.slice(-1) === ' ') return false;
  if (fileName.toLowerCase().slice(-extension.length) !== extension) return false;
  const stem = fileName.slice(0, -extension.length);
  if (!/[^.\s]/u.test(stem)) return false;
  const firstComponent = fileName.split('.')[0].replace(/\s+$/u, '');
  if (WINDOWS_DEVICE_NAME_PATTERN.test(firstComponent)) return false;
  for (let index = 0; index < fileName.length; index += 1) {
    const code = fileName.charCodeAt(index);
    if (
      code <= 31 ||
      (code >= 127 && code <= 159) ||
      WINDOWS_FORBIDDEN.indexOf(fileName[index]) >= 0
    ) {
      return false;
    }
  }
  return true;
};

function safeDisplayFileName(fileName, extension, jobId) {
  const normalizedExtension = typeof extension === 'string' ? extension.toLowerCase() : '';
  if (mediaTypeForExtension(normalizedExtension) === null) invalid('UNSUPPORTED_SOURCE');
  if (isWindowsSafeDisplayName(fileName, normalizedExtension)) {
    return `${fileName.slice(0, -normalizedExtension.length)}${normalizedExtension}`;
  }
  const identifier = isUuid(jobId) ? jobId.slice(0, 8) : '00000000';
  return `강의자료-${identifier}${normalizedExtension}`;
}

const validateSource = (value) => {
  if (!hasExactKeys(value, ['fileName', 'sizeBytes'])) invalid('UNSUPPORTED_SOURCE');
  if (typeof value.fileName !== 'string') invalid('UNSUPPORTED_SOURCE');
  const extensionIndex = value.fileName.lastIndexOf('.');
  const extension = extensionIndex < 0 ? '' : value.fileName.slice(extensionIndex).toLowerCase();
  const mediaType = mediaTypeForExtension(extension);
  if (mediaType === null || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0) {
    invalid('UNSUPPORTED_SOURCE');
  }
  const maximum =
    mediaType === 'audio' || mediaType === 'video'
      ? MAX_AUDIO_VIDEO_BYTES
      : MAX_DOCUMENT_IMAGE_BYTES;
  if (value.sizeBytes > maximum) invalid('SOURCE_TOO_LARGE');
  return frozen({ fileName: value.fileName, mediaType: mediaType, sizeBytes: value.sizeBytes });
};

const validateSourceDescriptorV2 = (value) => {
  const keys = isPlainObject(value) ? Object.keys(value) : [];
  const hasSha256 = keys.indexOf('sha256') !== -1;
  if (
    !hasExactKeys(
      value,
      hasSha256
        ? ['fileName', 'id', 'mediaType', 'sha256', 'sizeBytes']
        : ['fileName', 'id', 'mediaType', 'sizeBytes'],
    ) ||
    !isUuid(value.id) ||
    typeof value.mediaType !== 'string' ||
    (hasSha256 && (typeof value.sha256 !== 'string' || !SHA256_PATTERN.test(value.sha256)))
  ) {
    invalid('INVALID_QUEUE_ITEM');
  }
  let source;
  try {
    source = validateSource({ fileName: value.fileName, sizeBytes: value.sizeBytes });
  } catch (_error) {
    invalid('INVALID_QUEUE_ITEM');
  }
  if (
    source.mediaType !== value.mediaType ||
    source.sizeBytes < 1 ||
    !isWindowsSafeDisplayName(source.fileName, extensionFromFileName(source.fileName))
  ) {
    invalid('INVALID_QUEUE_ITEM');
  }
  return frozen({
    fileName: source.fileName,
    id: value.id,
    mediaType: source.mediaType,
    sizeBytes: source.sizeBytes,
    ...(hasSha256 ? { sha256: value.sha256 } : {}),
  });
};

const validateSourceBundleManifestV2 = (value) => {
  const hasCourseProvisioning =
    isPlainObject(value) && Object.keys(value).indexOf('courseProvisioning') !== -1;
  if (
    !hasExactKeys(
      value,
      hasCourseProvisioning
        ? [
            'courseId',
            'courseProvisioning',
            'createdAt',
            'jobId',
            'protocolVersion',
            'sources',
            'summaryMode',
          ]
        : ['courseId', 'createdAt', 'jobId', 'protocolVersion', 'sources', 'summaryMode'],
    ) ||
    value.protocolVersion !== SOURCE_BUNDLE_PROTOCOL_VERSION ||
    !isUuid(value.jobId) ||
    !isUuid(value.courseId) ||
    !isIsoWithOffset(value.createdAt) ||
    ['none', 'core', 'standard', 'full'].indexOf(value.summaryMode) === -1 ||
    !Array.isArray(value.sources) ||
    value.sources.length < 1 ||
    value.sources.length > MAX_SOURCES_PER_BUNDLE
  ) {
    invalid('INVALID_QUEUE_ITEM');
  }
  const sourceIds = new Set();
  let totalBytes = 0;
  const sources = value.sources.map((candidate) => {
    const source = validateSourceDescriptorV2(candidate);
    if (sourceIds.has(source.id)) invalid('INVALID_QUEUE_ITEM');
    sourceIds.add(source.id);
    totalBytes += source.sizeBytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_BUNDLE_BYTES) {
      invalid('INVALID_QUEUE_ITEM');
    }
    return source;
  });
  let courseProvisioning;
  if (hasCourseProvisioning) {
    try {
      courseProvisioning = validateCourseProvisioningInput(value.courseProvisioning);
    } catch (_error) {
      invalid('INVALID_QUEUE_ITEM');
    }
    if (courseProvisioning.id !== value.courseId) invalid('INVALID_QUEUE_ITEM');
  }
  return frozen({
    courseId: value.courseId,
    ...(hasCourseProvisioning ? { courseProvisioning: courseProvisioning } : {}),
    createdAt: value.createdAt,
    jobId: value.jobId,
    protocolVersion: SOURCE_BUNDLE_PROTOCOL_VERSION,
    sources: frozen(sources),
    summaryMode: value.summaryMode,
  });
};

const queueRootDiagnostic = (code) => {
  if (typeof code !== 'string') return null;
  const parts = code.split('|');
  if (
    parts.length < 2 ||
    parts.length > 3 ||
    parts[0] !== 'QUEUE_ROOT_CONFLICT' ||
    QUEUE_DIAGNOSTIC_STAGES.indexOf(parts[1]) === -1
  ) {
    return null;
  }
  if (parts.length === 2) {
    return frozen({ build: QUEUE_DIAGNOSTIC_BUILD, stage: parts[1] });
  }
  const observedFileSize = Number(parts[2]);
  if (!Number.isFinite(observedFileSize) || String(observedFileSize) !== parts[2]) return null;
  return frozen({
    build: QUEUE_DIAGNOSTIC_BUILD,
    observedFileSize: observedFileSize,
    stage: parts[1],
  });
};

const publicFailure = (code) => {
  const diagnostic = queueRootDiagnostic(code);
  if (diagnostic) {
    const observed =
      diagnostic.observedFileSize === undefined ? '' : `/${diagnostic.observedFileSize}`;
    return frozen({
      code: 'QUEUE_ROOT_CONFLICT',
      diagnostic: diagnostic,
      message: `${PUBLIC_RESULT_MESSAGES.QUEUE_ROOT_CONFLICT} [진단 ${diagnostic.build}/${diagnostic.stage}${observed}]`,
      ok: false,
    });
  }
  if (typeof code === 'string') {
    const parts = code.split('|');
    if (
      parts.length === 2 &&
      parts[0] === 'UNEXPECTED_ERROR' &&
      RUNTIME_DIAGNOSTIC_STAGES.indexOf(parts[1]) !== -1
    ) {
      const runtimeDiagnostic = frozen({ build: RUNTIME_DIAGNOSTIC_BUILD, stage: parts[1] });
      return frozen({
        code: 'UNEXPECTED_ERROR',
        diagnostic: runtimeDiagnostic,
        message: `${PUBLIC_RESULT_MESSAGES.UNEXPECTED_ERROR} [진단 ${runtimeDiagnostic.build}/${runtimeDiagnostic.stage}]`,
        ok: false,
      });
    }
  }
  const safeCode = PUBLIC_RESULT_MESSAGES[code] ? code : 'UNEXPECTED_ERROR';
  return frozen({ code: safeCode, message: PUBLIC_RESULT_MESSAGES[safeCode], ok: false });
};

const compactDiagnosticCount = (count) => (count === 0 ? '0' : count === 1 ? '1' : 'M');

const parameterAtomShape = (value) => {
  if (value === null) return 'N';
  if (typeof value === 'string') {
    if (value.length === 0) return 'S0';
    if (value.slice(0, 1) === '/') return 'SP';
    if (value.slice(0, 7).toLowerCase() === 'file://') return 'SU';
    return 'ST';
  }
  if (typeof value === 'undefined') return 'U';
  if (typeof value === 'boolean') return 'B';
  if (typeof value === 'number') return 'D';
  if (isPlainObject(value)) return `O${compactDiagnosticCount(Object.keys(value).length)}`;
  return 'X';
};

const shortcutParameterShape = (value) => {
  if (!Array.isArray(value)) return parameterAtomShape(value);
  const count = compactDiagnosticCount(value.length);
  return value.length === 0 ? `A${count}` : `A${count}-${parameterAtomShape(value[0])}`;
};

const invocationDiagnosticFailure = (result, runtimeArgs) => {
  if (
    !isPlainObject(result) ||
    (result.code !== 'INVALID_ACTION' && result.code !== 'INVALID_INPUT')
  )
    return result;
  const fileURLs = runtimeArgs ? runtimeArgs.fileURLs : undefined;
  const fileURLsShape = Array.isArray(fileURLs)
    ? fileURLs.length === 1
      ? `F1-${parameterAtomShape(fileURLs[0])}`
      : `F${compactDiagnosticCount(fileURLs.length)}`
    : fileURLs === null || fileURLs === undefined
      ? 'FN'
      : 'FX';
  const parameterShape = shortcutParameterShape(
    runtimeArgs ? runtimeArgs.shortcutParameter : undefined,
  );
  const diagnostic = frozen({
    build: INVOCATION_DIAGNOSTIC_BUILD,
    fileURLs: fileURLsShape,
    shortcutParameter: parameterShape,
  });
  return frozen({
    code: result.code,
    diagnostic: diagnostic,
    message: `${PUBLIC_RESULT_MESSAGES[result.code]} [진단 ${diagnostic.build}/${diagnostic.fileURLs}/${diagnostic.shortcutParameter}]`,
    ok: false,
  });
};

const enqueueSuccess = (jobId) =>
  frozen({
    action: 'enqueue',
    data: frozen({ jobId: jobId }),
    message: PUBLIC_STATUS_MESSAGES.queued,
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
  });

const enqueueCancellation = () =>
  frozen({
    action: 'enqueue',
    data: frozen({ cancelled: true }),
    message: '과목 선택을 취소했습니다.',
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
  });

const statusMessage = (counts) =>
  `대기 ${counts.queued} · 처리 중 ${counts.processing} · 완료 ${counts.completed} · 실패 ${counts.failed} · 확인 필요 ${counts.unreadableStatusFiles + counts.queueConflicts}`;

const statusSuccess = (counts) => {
  const failedItems = frozen(
    counts.failedItems
      .slice()
      .sort((left, right) => left.jobId.localeCompare(right.jobId))
      .map((item) => frozen({ displayMessage: item.displayMessage, jobId: item.jobId })),
  );
  const data = frozen({
    completed: counts.completed,
    failed: counts.failed,
    failedItems: failedItems,
    processing: counts.processing,
    queueConflicts: counts.queueConflicts,
    queued: counts.queued,
    unreadableStatusFiles: counts.unreadableStatusFiles,
  });
  return frozen({
    action: 'status',
    data: data,
    message: statusMessage(data),
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
  });
};

const queueRootConflict = (stage, observedFileSize) => {
  const safeStage = QUEUE_DIAGNOSTIC_STAGES.indexOf(stage) === -1 ? 'R00' : stage;
  const observed =
    typeof observedFileSize === 'number' && Number.isFinite(observedFileSize)
      ? `|${observedFileSize}`
      : '';
  invalid(`QUEUE_ROOT_CONFLICT|${safeStage}${observed}`);
};

const isExactOwnerMarker = (value) =>
  hasExactKeys(value, ['schemaVersion', 'owner', 'queueProtocolVersion']) &&
  value.schemaVersion === OWNER_MARKER.schemaVersion &&
  value.owner === OWNER_MARKER.owner &&
  value.queueProtocolVersion === OWNER_MARKER.queueProtocolVersion;

const ensureReservedDirectories = (fileManager, root) => {
  const directoryPaths = RESERVED_DIRECTORIES.map((directory) =>
    fileManager.joinPath(root, directory),
  );
  const existingDirectories = directoryPaths.map((path) => ({
    exists: fileManager.fileExists(path),
    path: path,
  }));
  for (let index = 0; index < existingDirectories.length; index += 1) {
    const directory = existingDirectories[index];
    if (directory.exists && !fileManager.isDirectory(directory.path)) queueRootConflict('R09');
  }
  for (let index = 0; index < existingDirectories.length; index += 1) {
    const directory = existingDirectories[index];
    if (!directory.exists) fileManager.createDirectory(directory.path);
  }
};

const ensureOwnedQueue = (fileManager) => {
  if (!fileManager || typeof fileManager.documentsDirectory !== 'function')
    queueRootConflict('R01');
  const root = fileManager.documentsDirectory();
  const markerPath = fileManager.joinPath(root, OWNER_MARKER_PATH);

  if (fileManager.fileExists(markerPath)) {
    if (fileManager.isDirectory(markerPath)) queueRootConflict('R03');
    if (typeof fileManager.fileSize !== 'function') queueRootConflict('R04');
    let markerSize;
    try {
      markerSize = fileManager.fileSize(markerPath);
    } catch (_error) {
      queueRootConflict('R05');
    }
    if (!Number.isFinite(markerSize) || markerSize < 0 || markerSize > MAX_OWNER_MARKER_BYTES) {
      queueRootConflict('R06');
    }
    let marker;
    try {
      marker = JSON.parse(fileManager.readString(markerPath));
    } catch (_error) {
      queueRootConflict('R07');
    }
    if (!isExactOwnerMarker(marker)) queueRootConflict('R08');
    ensureReservedDirectories(fileManager, root);
    return;
  }

  const reservedPaths = RESERVED_DIRECTORIES.map((directory) =>
    fileManager.joinPath(root, directory),
  );
  const existingReservedPaths = reservedPaths.map((path) => fileManager.fileExists(path));
  if (existingReservedPaths.some((exists) => exists)) queueRootConflict('R02');

  fileManager.writeString(markerPath, JSON.stringify(OWNER_MARKER));
  ensureReservedDirectories(fileManager, root);
};

const listQueueDirectory = (fileManager, path) => {
  if (typeof fileManager.listContents !== 'function') invalid('STATUS_READ_PARTIAL');
  let entries;
  try {
    entries = fileManager.listContents(path);
  } catch (_error) {
    invalid('STATUS_READ_PARTIAL');
  }
  if (!Array.isArray(entries) || entries.length > MAX_STATUS_DIRECTORY_ENTRIES) {
    invalid('STATUS_READ_PARTIAL');
  }
  for (let index = 0; index < entries.length; index += 1) {
    if (typeof entries[index] !== 'string' || entries[index].length < 1) {
      invalid('STATUS_READ_PARTIAL');
    }
  }
  return entries.slice().sort();
};

const isSafeStatusFileName = (value) => {
  if (typeof value !== 'string' || value.length < 1 || value.length > 180) return false;
  if (value === '.' || value === '..' || value.slice(-5) !== '.json') return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      value[index] === '/' ||
      value[index] === '\\' ||
      code <= 31 ||
      (code >= 127 && code <= 159)
    ) {
      return false;
    }
  }
  return true;
};

const exactUtf8ByteLength = (dependencies, text) => {
  if (typeof dependencies.dataFromString !== 'function' || typeof text !== 'string') return null;
  try {
    const data = dependencies.dataFromString(text);
    if (!data || typeof data.getBytes !== 'function') return null;
    const bytes = data.getBytes();
    if (
      !bytes ||
      typeof bytes.length !== 'number' ||
      !Number.isSafeInteger(bytes.length) ||
      bytes.length < 0
    )
      return null;
    return bytes.length;
  } catch (_error) {
    return null;
  }
};

const calibratedRuntimeFileManager = async (rawFileManager, dataFromString) => {
  if (
    !rawFileManager ||
    typeof rawFileManager.documentsDirectory !== 'function' ||
    typeof rawFileManager.fileExists !== 'function' ||
    typeof rawFileManager.fileSize !== 'function' ||
    typeof rawFileManager.readString !== 'function' ||
    typeof rawFileManager.isDirectory !== 'function' ||
    typeof rawFileManager.joinPath !== 'function'
  ) {
    queueRootConflict('R01');
  }
  const root = rawFileManager.documentsDirectory();
  const markerPath = rawFileManager.joinPath(root, OWNER_MARKER_PATH);
  if (!rawFileManager.fileExists(markerPath)) ensureOwnedQueue(rawFileManager);
  if (rawFileManager.isDirectory(markerPath)) queueRootConflict('R03');
  if (
    typeof rawFileManager.isFileDownloaded === 'function' &&
    !rawFileManager.isFileDownloaded(markerPath)
  ) {
    if (typeof rawFileManager.downloadFileFromiCloud !== 'function') queueRootConflict('R10');
    try {
      await rawFileManager.downloadFileFromiCloud(markerPath);
    } catch (_error) {
      queueRootConflict('R11');
    }
    if (
      !rawFileManager.fileExists(markerPath) ||
      rawFileManager.isDirectory(markerPath) ||
      !rawFileManager.isFileDownloaded(markerPath)
    ) {
      queueRootConflict('R12');
    }
  }
  let rawMarkerSize;
  let markerText;
  try {
    rawMarkerSize = rawFileManager.fileSize(markerPath);
    if (
      typeof rawMarkerSize !== 'number' ||
      !Number.isFinite(rawMarkerSize) ||
      rawMarkerSize < 0 ||
      rawMarkerSize > MAX_OWNER_MARKER_BYTES
    ) {
      queueRootConflict('R06');
    }
    markerText = rawFileManager.readString(markerPath);
  } catch (_error) {
    queueRootConflict('R13');
  }
  const markerBytes = exactUtf8ByteLength({ dataFromString: dataFromString }, markerText);
  if (
    markerBytes === null ||
    !Number.isSafeInteger(markerBytes) ||
    markerBytes < 1 ||
    markerBytes > MAX_OWNER_MARKER_BYTES
  ) {
    queueRootConflict('R14');
  }
  try {
    if (!isExactOwnerMarker(JSON.parse(markerText))) queueRootConflict('R15');
  } catch (_error) {
    queueRootConflict('R15');
  }
  const scales = [1, 1000, 1024].filter((scale) => {
    const bytes = rawMarkerSize * scale;
    return Number.isSafeInteger(bytes) && bytes === markerBytes;
  });
  const usesWholeKilobytes = scales.length === 0 && rawMarkerSize === 0;
  if (scales.length !== 1 && !usesWholeKilobytes) queueRootConflict('R16', rawMarkerSize);
  const scale = usesWholeKilobytes ? 1024 : scales[0];
  const forward = (name) => {
    const method = rawFileManager[name];
    if (typeof method !== 'function') return undefined;
    return (...args) => method.apply(rawFileManager, args);
  };
  const fileSizeToken = (path) => {
    const rawSize = rawFileManager.fileSize(path);
    if (
      typeof rawSize !== 'number' ||
      !Number.isFinite(rawSize) ||
      rawSize < 0 ||
      (usesWholeKilobytes && !Number.isSafeInteger(rawSize))
    ) {
      queueRootConflict('R17');
    }
    return rawSize;
  };
  const fileSize = (path) => {
    const rawSize = fileSizeToken(path);
    const bytes = usesWholeKilobytes ? (rawSize + 1) * scale - 1 : rawSize * scale;
    if (!Number.isSafeInteger(bytes) || bytes < 0) queueRootConflict('R17');
    return bytes;
  };
  return frozen({
    copy: forward('copy'),
    createDirectory: forward('createDirectory'),
    documentsDirectory: forward('documentsDirectory'),
    downloadFileFromiCloud: forward('downloadFileFromiCloud'),
    fileExists: forward('fileExists'),
    fileName: forward('fileName'),
    fileSize: fileSize,
    fileSizeIsExact: !usesWholeKilobytes,
    fileSizeToken: fileSizeToken,
    isDirectory: forward('isDirectory'),
    isFileDownloaded: forward('isFileDownloaded'),
    joinPath: forward('joinPath'),
    listContents: forward('listContents'),
    modificationDate: forward('modificationDate'),
    move: forward('move'),
    readString: forward('readString'),
    remove: forward('remove'),
    write: forward('write'),
    writeString: forward('writeString'),
  });
};

const observedFileSizeToken = (fileManager, path) => {
  const observe =
    typeof fileManager.fileSizeToken === 'function'
      ? fileManager.fileSizeToken
      : fileManager.fileSize;
  if (typeof observe !== 'function') return null;
  try {
    const value = observe.call(fileManager, path);
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  } catch (_error) {
    return null;
  }
};

const observedFileModificationToken = (fileManager, path) => {
  if (typeof fileManager.modificationDate !== 'function') return null;
  try {
    const value = fileManager.modificationDate(path);
    if (value === null || typeof value !== 'object' || typeof value.getTime !== 'function') {
      return null;
    }
    const timestamp = value.getTime();
    return typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : null;
  } catch (_error) {
    return null;
  }
};

const observedCoarseModificationToken = (fileManager, path) =>
  fileManager.fileSizeIsExact === false ? observedFileModificationToken(fileManager, path) : 0;

const observeStableEmptyTextFile = (fileManager, path) => {
  const beforeToken = observedFileSizeToken(fileManager, path);
  if (beforeToken === null) return null;
  if (beforeToken !== 0) return false;
  const beforeModification = observedCoarseModificationToken(fileManager, path);
  if (beforeModification === null) return null;
  const firstText = fileManager.readString(path);
  const betweenToken = observedFileSizeToken(fileManager, path);
  if (betweenToken === null || betweenToken !== beforeToken) return null;
  const secondText = fileManager.readString(path);
  const afterToken = observedFileSizeToken(fileManager, path);
  if (afterToken === null || afterToken !== betweenToken) return null;
  const thirdText = fileManager.readString(path);
  const finalToken = observedFileSizeToken(fileManager, path);
  if (finalToken === null || finalToken !== afterToken) return null;
  const afterModification = observedCoarseModificationToken(fileManager, path);
  if (afterModification === null) return null;
  if (afterModification !== beforeModification) return false;
  return firstText === '' && secondText === '' && thirdText === '';
};

const observedTextSizeMayFit = (fileManager, byteSize, sizeToken, maximumBytes) => {
  if (!Number.isSafeInteger(byteSize) || byteSize < 0 || sizeToken === null) return false;
  if (fileManager.fileSizeIsExact !== false) return byteSize <= maximumBytes;
  return (
    Number.isSafeInteger(sizeToken) &&
    sizeToken >= 0 &&
    sizeToken <= Math.floor(maximumBytes / WHOLE_KILOBYTE_BYTES)
  );
};

const observedReadyIds = async (dependencies, fileManager, lanePath, metadataFileName) => {
  const readyIds = Object.create(null);
  const entries = listQueueDirectory(fileManager, lanePath);
  if (
    typeof fileManager.fileExists !== 'function' ||
    typeof fileManager.isDirectory !== 'function' ||
    typeof fileManager.fileSize !== 'function' ||
    typeof fileManager.readString !== 'function' ||
    typeof fileManager.listContents !== 'function'
  ) {
    invalid('STATUS_READ_PARTIAL');
  }
  for (let index = 0; index < entries.length; index += 1) {
    const jobId = entries[index];
    if (!isUuid(jobId)) continue;
    try {
      const jobPath = fileManager.joinPath(lanePath, jobId);
      if (fileManager.isDirectory(jobPath) !== true) continue;
      const initialEntries = sortedBoundedDirectoryEntries(fileManager, jobPath, 4);
      if (initialEntries === null) invalid('STATUS_READ_PARTIAL');
      if (sameSortedEntries(initialEntries, ['manifest.json', 'sources'])) {
        const manifest = await observeStableV2Bundle(
          dependencies,
          fileManager,
          jobPath,
          jobId,
          metadataFileName === 'request.json' ? 'required' : 'forbidden',
        );
        if (manifest !== null) readyIds[jobId] = true;
        continue;
      }
      if (initialEntries.length !== 3) continue;
      const sourceEntries = initialEntries.filter((entry) => {
        const extension = extensionFromFileName(entry);
        return entry === `source${extension}` && mediaTypeForExtension(extension) !== null;
      });
      if (
        sourceEntries.length !== 1 ||
        initialEntries.indexOf(metadataFileName) === -1 ||
        initialEntries.indexOf('ready') === -1
      ) {
        continue;
      }
      const metadataPath = fileManager.joinPath(jobPath, metadataFileName);
      const sourcePath = fileManager.joinPath(jobPath, sourceEntries[0]);
      if (
        !fileManager.fileExists(metadataPath) ||
        fileManager.isDirectory(metadataPath) !== false ||
        !fileManager.fileExists(sourcePath) ||
        fileManager.isDirectory(sourcePath) !== false
      ) {
        continue;
      }
      const metadataSize = fileManager.fileSize(metadataPath);
      const metadataToken = observedFileSizeToken(fileManager, metadataPath);
      if (
        !observedTextSizeMayFit(fileManager, metadataSize, metadataToken, MAX_COURSE_REQUEST_BYTES)
      ) {
        continue;
      }
      const metadataModification = observedFileModificationToken(fileManager, metadataPath);
      if (metadataModification === null) invalid('STATUS_READ_PARTIAL');
      const sourceSize = fileManager.fileSize(sourcePath);
      const sourceToken = observedFileSizeToken(fileManager, sourcePath);
      const sourceMediaType = mediaTypeForExtension(extensionFromFileName(sourceEntries[0]));
      const maximumSourceBytes =
        sourceMediaType === 'audio' || sourceMediaType === 'video'
          ? MAX_AUDIO_VIDEO_BYTES
          : MAX_DOCUMENT_IMAGE_BYTES;
      if (!observedTextSizeMayFit(fileManager, sourceSize, sourceToken, maximumSourceBytes)) {
        continue;
      }
      const sourceModification = observedFileModificationToken(fileManager, sourcePath);
      if (sourceModification === null) invalid('STATUS_READ_PARTIAL');
      const readyPath = fileManager.joinPath(jobPath, 'ready');
      if (fileManager.fileExists(readyPath) !== true) continue;
      if (fileManager.isDirectory(readyPath) !== false) continue;
      const remoteToken = observedFileSizeToken(fileManager, readyPath);
      if (remoteToken === null) invalid('STATUS_READ_PARTIAL');
      if (remoteToken !== 0) continue;
      if (
        typeof fileManager.isFileDownloaded === 'function' &&
        !fileManager.isFileDownloaded(readyPath)
      ) {
        if (typeof fileManager.downloadFileFromiCloud !== 'function')
          invalid('STATUS_READ_PARTIAL');
        await fileManager.downloadFileFromiCloud(readyPath);
        if (!fileManager.isFileDownloaded(readyPath)) invalid('STATUS_READ_PARTIAL');
      }
      const localToken = observedFileSizeToken(fileManager, readyPath);
      if (localToken === null) invalid('STATUS_READ_PARTIAL');
      if (localToken !== 0) continue;
      const isReady = observeStableEmptyTextFile(fileManager, readyPath);
      if (isReady === null) invalid('STATUS_READ_PARTIAL');
      if (!isReady) continue;
      const finalEntries = sortedBoundedDirectoryEntries(fileManager, jobPath, 4);
      if (finalEntries === null) invalid('STATUS_READ_PARTIAL');
      if (
        finalEntries.length !== initialEntries.length ||
        finalEntries.some((entry, entryIndex) => entry !== initialEntries[entryIndex]) ||
        observedFileSizeToken(fileManager, metadataPath) !== metadataToken ||
        observedFileModificationToken(fileManager, metadataPath) !== metadataModification ||
        observedFileSizeToken(fileManager, sourcePath) !== sourceToken ||
        observedFileModificationToken(fileManager, sourcePath) !== sourceModification
      ) {
        continue;
      }
      readyIds[jobId] = true;
    } catch (error) {
      if (error && error.message === 'STATUS_READ_PARTIAL') throw error;
      invalid('STATUS_READ_PARTIAL');
    }
  }
  return readyIds;
};

const observeStatusReceipt = async (dependencies, fileManager, receiptPath) => {
  try {
    if (
      typeof fileManager.fileExists !== 'function' ||
      typeof fileManager.isDirectory !== 'function' ||
      typeof fileManager.fileSize !== 'function' ||
      fileManager.fileExists(receiptPath) !== true ||
      fileManager.isDirectory(receiptPath) !== false
    ) {
      return null;
    }
    const remoteSize = fileManager.fileSize(receiptPath);
    const remoteToken = observedFileSizeToken(fileManager, receiptPath);
    if (!observedTextSizeMayFit(fileManager, remoteSize, remoteToken, MAX_STATUS_RECEIPT_BYTES)) {
      return null;
    }
    if (
      typeof fileManager.isFileDownloaded === 'function' &&
      !fileManager.isFileDownloaded(receiptPath)
    ) {
      if (typeof fileManager.downloadFileFromiCloud !== 'function') return null;
      await fileManager.downloadFileFromiCloud(receiptPath);
      if (!fileManager.isFileDownloaded(receiptPath)) return null;
    }
    const beforeSize = fileManager.fileSize(receiptPath);
    const beforeToken = observedFileSizeToken(fileManager, receiptPath);
    if (!observedTextSizeMayFit(fileManager, beforeSize, beforeToken, MAX_STATUS_RECEIPT_BYTES))
      return null;
    // Treat iCloud metadata as the download bound; a token transition is not a stable snapshot.
    if (beforeToken !== remoteToken) return null;
    const beforeModification = observedCoarseModificationToken(fileManager, receiptPath);
    if (beforeModification === null) return null;
    const raw = fileManager.readString(receiptPath);
    if (typeof raw !== 'string' || raw.length > MAX_STATUS_RECEIPT_BYTES) return null;
    const afterToken = observedFileSizeToken(fileManager, receiptPath);
    if (afterToken === null || afterToken !== beforeToken) return null;
    const afterModification = observedCoarseModificationToken(fileManager, receiptPath);
    if (afterModification === null || afterModification !== beforeModification) return null;
    const exactSize = exactUtf8ByteLength(dependencies, raw);
    if (
      exactSize === null ||
      exactSize > MAX_STATUS_RECEIPT_BYTES ||
      (fileManager.fileSizeIsExact !== false && exactSize !== beforeSize)
    )
      return null;
    return validateStatusReceipt(JSON.parse(raw));
  } catch (_error) {
    return null;
  }
};

const aggregateStatus = async (dependencies, fileManager) => {
  const root = fileManager.documentsDirectory();
  const inboxPath = fileManager.joinPath(root, 'Inbox');
  const courseInboxPath = fileManager.joinPath(root, 'CourseInbox');
  const statusPath = fileManager.joinPath(root, 'Status');
  const inboxReady = await observedReadyIds(dependencies, fileManager, inboxPath, 'manifest.json');
  const courseReady = await observedReadyIds(
    dependencies,
    fileManager,
    courseInboxPath,
    'request.json',
  );
  const queueConflicts = Object.keys(inboxReady).filter((jobId) => courseReady[jobId]).length;
  const readyIds = Object.assign(Object.create(null), inboxReady, courseReady);
  const statusEntries = listQueueDirectory(fileManager, statusPath);
  const latestByJobId = Object.create(null);
  let unreadableStatusFiles = 0;
  for (let index = 0; index < statusEntries.length; index += 1) {
    const entryName = statusEntries[index];
    if (entryName.slice(-5) !== '.json') continue;
    if (!isSafeStatusFileName(entryName)) {
      unreadableStatusFiles += 1;
      continue;
    }
    const receipt = await observeStatusReceipt(
      dependencies,
      fileManager,
      fileManager.joinPath(statusPath, entryName),
    );
    if (receipt === null) {
      unreadableStatusFiles += 1;
      continue;
    }
    const existing = latestByJobId[receipt.jobId];
    // Names are sorted ascending; an equal instant retains the first name as a stable winner.
    if (!existing || Date.parse(receipt.updatedAt) > Date.parse(existing.updatedAt)) {
      latestByJobId[receipt.jobId] = receipt;
    }
  }
  const jobIds = Object.keys(readyIds);
  Object.keys(latestByJobId).forEach((jobId) => {
    if (!readyIds[jobId]) jobIds.push(jobId);
  });
  const counts = {
    completed: 0,
    failed: 0,
    failedItems: [],
    processing: 0,
    queueConflicts: queueConflicts,
    queued: 0,
    unreadableStatusFiles: unreadableStatusFiles,
  };
  jobIds.forEach((jobId) => {
    const receipt = latestByJobId[jobId];
    if (!receipt) {
      counts.queued += 1;
      return;
    }
    counts[receipt.status] += 1;
    if (receipt.status === 'failed') {
      counts.failedItems.push({ displayMessage: receipt.displayMessage, jobId: receipt.jobId });
    }
  });
  return statusSuccess(counts);
};

const fileNameFromPath = (fileManager, sourcePath) => {
  if (typeof fileManager.fileName === 'function') return fileManager.fileName(sourcePath, true);
  const segments = sourcePath.split('/');
  return segments[segments.length - 1];
};

const extensionFromFileName = (fileName) => {
  const index = fileName.lastIndexOf('.');
  return index < 0 ? '' : fileName.slice(index).toLowerCase();
};

const ensureLocalFile = async (fileManager, sourcePath) => {
  if (
    typeof fileManager.fileExists !== 'function' ||
    typeof fileManager.isDirectory !== 'function' ||
    !fileManager.fileExists(sourcePath) ||
    fileManager.isDirectory(sourcePath)
  ) {
    invalid('UNSUPPORTED_SOURCE');
  }
  if (
    typeof fileManager.isFileDownloaded === 'function' &&
    !fileManager.isFileDownloaded(sourcePath)
  ) {
    if (typeof fileManager.downloadFileFromiCloud !== 'function') invalid('SOURCE_COPY_FAILED');
    await fileManager.downloadFileFromiCloud(sourcePath);
    if (
      !fileManager.fileExists(sourcePath) ||
      fileManager.isDirectory(sourcePath) ||
      !fileManager.isFileDownloaded(sourcePath)
    ) {
      invalid('SOURCE_COPY_FAILED');
    }
  }
};

const describeSourcePath = async (fileManager, sourcePath) => {
  await ensureLocalFile(fileManager, sourcePath);
  if (typeof fileManager.fileSize !== 'function') invalid('UNSUPPORTED_SOURCE');
  const fileName = fileNameFromPath(fileManager, sourcePath);
  const source = validateSource({
    fileName: fileName,
    sizeBytes: fileManager.fileSize(sourcePath),
  });
  return frozen({
    extension: extensionFromFileName(source.fileName),
    fileName: source.fileName,
    mediaType: source.mediaType,
    sizeBytes: source.sizeBytes,
  });
};

const observeBoundedTextSnapshot = async (dependencies, fileManager, path, maximumBytes) => {
  try {
    if (
      typeof fileManager.fileSize !== 'function' ||
      typeof fileManager.readString !== 'function' ||
      !fileManager.fileExists(path) ||
      fileManager.isDirectory(path)
    ) {
      return null;
    }
    const remoteSize = fileManager.fileSize(path);
    const remoteToken = observedFileSizeToken(fileManager, path);
    if (!observedTextSizeMayFit(fileManager, remoteSize, remoteToken, maximumBytes)) return null;
    if (typeof fileManager.isFileDownloaded === 'function' && !fileManager.isFileDownloaded(path)) {
      if (typeof fileManager.downloadFileFromiCloud !== 'function') return null;
      await fileManager.downloadFileFromiCloud(path);
      if (!fileManager.isFileDownloaded(path)) return null;
    }
    const beforeSize = fileManager.fileSize(path);
    const beforeToken = observedFileSizeToken(fileManager, path);
    if (!observedTextSizeMayFit(fileManager, beforeSize, beforeToken, maximumBytes)) return null;
    if (beforeToken !== remoteToken) return null;
    const beforeModification = observedFileModificationToken(fileManager, path);
    if (beforeModification === null) return null;
    const raw = fileManager.readString(path);
    if (typeof raw !== 'string' || raw.length > maximumBytes) return null;
    const afterToken = observedFileSizeToken(fileManager, path);
    const afterModification = observedFileModificationToken(fileManager, path);
    const exactSize = exactUtf8ByteLength(dependencies, raw);
    if (
      exactSize === null ||
      exactSize > maximumBytes ||
      afterToken === null ||
      afterToken !== beforeToken ||
      afterModification === null ||
      afterModification !== beforeModification ||
      (fileManager.fileSizeIsExact !== false && exactSize !== beforeSize)
    ) {
      return null;
    }
    return frozen({
      modificationToken: afterModification,
      raw: raw,
      sizeToken: afterToken,
    });
  } catch (_error) {
    return null;
  }
};

const observeBoundedTextFile = async (dependencies, fileManager, path, maximumBytes) => {
  const snapshot = await observeBoundedTextSnapshot(dependencies, fileManager, path, maximumBytes);
  return snapshot === null ? null : snapshot.raw;
};

const sortedBoundedDirectoryEntries = (fileManager, path, maximumEntries) => {
  try {
    if (typeof fileManager.listContents !== 'function') return null;
    const entries = fileManager.listContents(path);
    if (!Array.isArray(entries) || entries.length > maximumEntries) return null;
    for (let index = 0; index < entries.length; index += 1) {
      if (
        typeof entries[index] !== 'string' ||
        entries[index].length < 1 ||
        entries[index].indexOf('/') !== -1 ||
        entries[index].indexOf('\\') !== -1
      ) {
        return null;
      }
    }
    return entries.slice().sort();
  } catch (_error) {
    return null;
  }
};

const sameSortedEntries = (left, right) =>
  left.length === right.length && left.every((entry, index) => entry === right[index]);

const observeStableV2Bundle = async (
  dependencies,
  fileManager,
  jobPath,
  jobId,
  courseProvisioningRule,
) => {
  try {
    const initialEntries = sortedBoundedDirectoryEntries(fileManager, jobPath, 3);
    if (
      initialEntries === null ||
      !sameSortedEntries(initialEntries, ['manifest.json', 'sources'])
    ) {
      return null;
    }
    const manifestPath = fileManager.joinPath(jobPath, 'manifest.json');
    const sourcesPath = fileManager.joinPath(jobPath, 'sources');
    if (
      !fileManager.fileExists(manifestPath) ||
      fileManager.isDirectory(manifestPath) !== false ||
      !fileManager.fileExists(sourcesPath) ||
      fileManager.isDirectory(sourcesPath) !== true
    ) {
      return null;
    }
    const initialManifestSnapshot = await observeBoundedTextSnapshot(
      dependencies,
      fileManager,
      manifestPath,
      MAX_COURSE_REQUEST_BYTES,
    );
    if (initialManifestSnapshot === null) return null;
    const manifest = validateSourceBundleManifestV2(JSON.parse(initialManifestSnapshot.raw));
    if (manifest.jobId !== jobId) return null;
    if (courseProvisioningRule === 'required' && !manifest.courseProvisioning) return null;
    if (courseProvisioningRule === 'forbidden' && manifest.courseProvisioning) return null;
    const initialSourceEntries = sortedBoundedDirectoryEntries(
      fileManager,
      sourcesPath,
      MAX_SOURCES_PER_BUNDLE,
    );
    if (initialSourceEntries === null || initialSourceEntries.length !== manifest.sources.length) {
      return null;
    }
    const expectedSourceEntries = manifest.sources
      .map((source, index) => sourceFileName(source, source.id, index))
      .sort();
    if (!sameSortedEntries(initialSourceEntries, expectedSourceEntries)) return null;
    const sourceSnapshots = [];
    for (let index = 0; index < manifest.sources.length; index += 1) {
      const source = manifest.sources[index];
      const path = fileManager.joinPath(sourcesPath, sourceFileName(source, source.id, index));
      if (!fileManager.fileExists(path) || fileManager.isDirectory(path) !== false) return null;
      const sizeBytes = fileManager.fileSize(path);
      const sizeToken = observedFileSizeToken(fileManager, path);
      const modificationToken = observedFileModificationToken(fileManager, path);
      if (sizeBytes !== source.sizeBytes || sizeToken === null || modificationToken === null) {
        return null;
      }
      sourceSnapshots.push(
        frozen({ modificationToken: modificationToken, path: path, sizeToken: sizeToken }),
      );
    }
    const finalEntries = sortedBoundedDirectoryEntries(fileManager, jobPath, 3);
    const finalSourceEntries = sortedBoundedDirectoryEntries(
      fileManager,
      sourcesPath,
      MAX_SOURCES_PER_BUNDLE,
    );
    const finalManifestSnapshot = await observeBoundedTextSnapshot(
      dependencies,
      fileManager,
      manifestPath,
      MAX_COURSE_REQUEST_BYTES,
    );
    if (
      finalEntries === null ||
      !sameSortedEntries(finalEntries, initialEntries) ||
      finalSourceEntries === null ||
      !sameSortedEntries(finalSourceEntries, initialSourceEntries) ||
      finalManifestSnapshot === null ||
      finalManifestSnapshot.raw !== initialManifestSnapshot.raw ||
      finalManifestSnapshot.sizeToken !== initialManifestSnapshot.sizeToken ||
      finalManifestSnapshot.modificationToken !== initialManifestSnapshot.modificationToken ||
      sourceSnapshots.some(
        (snapshot) =>
          observedFileSizeToken(fileManager, snapshot.path) !== snapshot.sizeToken ||
          observedFileModificationToken(fileManager, snapshot.path) !== snapshot.modificationToken,
      )
    ) {
      return null;
    }
    return manifest;
  } catch (_error) {
    return null;
  }
};

const matchingRejectionExists = async (dependencies, fileManager, root, jobId) => {
  const receiptPath = fileManager.joinPath(fileManager.joinPath(root, 'Rejected'), `${jobId}.json`);
  if (!fileManager.fileExists(receiptPath)) return false;
  const raw = await observeBoundedTextFile(
    dependencies,
    fileManager,
    receiptPath,
    MAX_STATUS_RECEIPT_BYTES,
  );
  if (raw === null) return false;
  try {
    return validateRejectionReceipt(JSON.parse(raw)).jobId === jobId;
  } catch (_error) {
    return false;
  }
};

const courseInboxRequestsMatch = (left, right) =>
  left.protocolVersion === right.protocolVersion &&
  left.jobId === right.jobId &&
  left.createdAt === right.createdAt &&
  left.summaryMode === right.summaryMode &&
  left.course.id === right.course.id &&
  left.course.name === right.course.name &&
  left.course.professorName === right.course.professorName &&
  left.source.fileName === right.source.fileName &&
  left.source.mediaType === right.source.mediaType;

const observePendingCourse = async (dependencies, fileManager, root, jobId) => {
  try {
    const courseInboxPath = fileManager.joinPath(root, 'CourseInbox');
    const jobPath = fileManager.joinPath(courseInboxPath, jobId);
    if (!fileManager.fileExists(jobPath) || fileManager.isDirectory(jobPath) !== true) return null;
    if (await matchingRejectionExists(dependencies, fileManager, root, jobId)) return null;
    const initialEntries = sortedBoundedDirectoryEntries(fileManager, jobPath, 4);
    if (
      initialEntries !== null &&
      sameSortedEntries(initialEntries, ['manifest.json', 'sources'])
    ) {
      const manifest = await observeStableV2Bundle(
        dependencies,
        fileManager,
        jobPath,
        jobId,
        'required',
      );
      if (
        manifest === null ||
        (await matchingRejectionExists(dependencies, fileManager, root, jobId))
      ) {
        return null;
      }
      return manifest.courseProvisioning;
    }
    if (initialEntries === null || initialEntries.length !== 3) return null;
    const sourceEntries = initialEntries.filter(
      (entry) =>
        entry.slice(0, 7) === 'source.' && mediaTypeForExtension(`.${entry.split('.').pop()}`),
    );
    if (
      sourceEntries.length !== 1 ||
      initialEntries.indexOf('request.json') === -1 ||
      initialEntries.indexOf('ready') === -1
    ) {
      return null;
    }
    const requestPath = fileManager.joinPath(jobPath, 'request.json');
    const requestSnapshot = await observeBoundedTextSnapshot(
      dependencies,
      fileManager,
      requestPath,
      MAX_COURSE_REQUEST_BYTES,
    );
    if (requestSnapshot === null) return null;
    const requestRaw = requestSnapshot.raw;
    let request;
    try {
      request = validateCourseInboxRequest(JSON.parse(requestRaw));
    } catch (_error) {
      return null;
    }
    if (request.jobId !== jobId) return null;
    const sourceName = sourceEntries[0];
    const sourcePath = fileManager.joinPath(jobPath, sourceName);
    if (!fileManager.fileExists(sourcePath) || fileManager.isDirectory(sourcePath) !== false) {
      return null;
    }
    const sourceExtension = sourceName.slice('source'.length).toLowerCase();
    if (
      sourceExtension !== request.source.fileName.slice(-sourceExtension.length).toLowerCase() ||
      mediaTypeForExtension(sourceExtension) !== request.source.mediaType
    ) {
      return null;
    }
    const sourceSize = fileManager.fileSize(sourcePath);
    const sourceToken = observedFileSizeToken(fileManager, sourcePath);
    const maximumSourceBytes =
      request.source.mediaType === 'audio' || request.source.mediaType === 'video'
        ? MAX_AUDIO_VIDEO_BYTES
        : MAX_DOCUMENT_IMAGE_BYTES;
    if (!observedTextSizeMayFit(fileManager, sourceSize, sourceToken, maximumSourceBytes)) {
      return null;
    }
    const sourceModification = observedFileModificationToken(fileManager, sourcePath);
    if (sourceModification === null) return null;
    const readyPath = fileManager.joinPath(jobPath, 'ready');
    if (!fileManager.fileExists(readyPath) || fileManager.isDirectory(readyPath) !== false) {
      return null;
    }
    const remoteReadyToken = observedFileSizeToken(fileManager, readyPath);
    if (remoteReadyToken !== 0) return null;
    if (
      typeof fileManager.isFileDownloaded === 'function' &&
      !fileManager.isFileDownloaded(readyPath)
    ) {
      if (typeof fileManager.downloadFileFromiCloud !== 'function') return null;
      await fileManager.downloadFileFromiCloud(readyPath);
      if (!fileManager.isFileDownloaded(readyPath)) return null;
    }
    if (observedFileSizeToken(fileManager, readyPath) !== remoteReadyToken) return null;
    if (observeStableEmptyTextFile(fileManager, readyPath) !== true) return null;
    if (
      observedFileSizeToken(fileManager, sourcePath) !== sourceToken ||
      observedFileModificationToken(fileManager, sourcePath) !== sourceModification
    ) {
      return null;
    }
    const finalEntries = sortedBoundedDirectoryEntries(fileManager, jobPath, 4);
    if (
      finalEntries === null ||
      finalEntries.length !== initialEntries.length ||
      finalEntries.some((entry, index) => entry !== initialEntries[index])
    ) {
      return null;
    }
    const finalRequestSnapshot = await observeBoundedTextSnapshot(
      dependencies,
      fileManager,
      requestPath,
      MAX_COURSE_REQUEST_BYTES,
    );
    if (
      finalRequestSnapshot === null ||
      finalRequestSnapshot.raw !== requestSnapshot.raw ||
      finalRequestSnapshot.sizeToken !== requestSnapshot.sizeToken ||
      finalRequestSnapshot.modificationToken !== requestSnapshot.modificationToken
    ) {
      return null;
    }
    const finalRequestRaw = finalRequestSnapshot.raw;
    let finalRequest;
    try {
      finalRequest = validateCourseInboxRequest(JSON.parse(finalRequestRaw));
    } catch (_error) {
      return null;
    }
    if (!courseInboxRequestsMatch(request, finalRequest)) return null;
    if (await matchingRejectionExists(dependencies, fileManager, root, jobId)) return null;
    return request.course;
  } catch (_error) {
    return null;
  }
};

const discoverPendingCourses = async (dependencies, fileManager, root) => {
  const courseInboxPath = fileManager.joinPath(root, 'CourseInbox');
  const entries = sortedBoundedDirectoryEntries(
    fileManager,
    courseInboxPath,
    MAX_COURSE_INBOX_ENTRIES,
  );
  if (entries === null) invalid('CATALOG_INVALID');
  const definitionsById = new Map();
  for (let index = 0; index < entries.length; index += 1) {
    const jobId = entries[index];
    if (!isUuid(jobId)) continue;
    const course = await observePendingCourse(dependencies, fileManager, root, jobId);
    if (course === null) continue;
    const existing = definitionsById.get(course.id);
    if (existing === undefined) {
      definitionsById.set(course.id, frozen({ conflicted: false, course: course }));
      continue;
    }
    if (
      existing.course.name !== course.name ||
      existing.course.professorName !== course.professorName
    ) {
      definitionsById.set(course.id, frozen({ conflicted: true, course: existing.course }));
    }
  }
  return frozen({
    courses: frozen(
      Array.from(definitionsById.values())
        .filter((definition) => !definition.conflicted)
        .map((definition) => definition.course),
    ),
    ids: frozen(Array.from(definitionsById.keys())),
  });
};

const compareCourseChoices = (left, right) => {
  const byLabel = left.label.localeCompare(right.label, 'ko');
  if (byLabel !== 0) return byLabel;
  return left.course.id.localeCompare(right.course.id);
};

const mergeCourseChoices = (catalogCourses, pendingCourses) => {
  const canonicalIds = new Set();
  const merged = catalogCourses.map((course) => {
    canonicalIds.add(course.id);
    return frozen({ course: course, kind: 'catalog', label: course.name });
  });
  for (let index = 0; index < pendingCourses.length; index += 1) {
    const course = pendingCourses[index];
    if (!canonicalIds.has(course.id)) {
      merged.push(frozen({ course: course, kind: 'pending', label: `${course.name} (생성 대기)` }));
    }
  }
  return frozen(merged.slice().sort(compareCourseChoices));
};

const courseOptionsSuccess = (choices) => {
  const labels = [];
  const usedLabels = new Set([ADD_COURSE_LABEL]);
  const courseIdsByLabel = {};
  for (let index = 0; index < choices.length; index += 1) {
    const choice = choices[index];
    const baseLabel = choice.label;
    let label = baseLabel;
    let suffix = 1;
    while (usedLabels.has(label)) {
      label = `${baseLabel} · ${suffix}`;
      suffix += 1;
    }
    usedLabels.add(label);
    labels.push(label);
    Object.defineProperty(courseIdsByLabel, label, {
      configurable: false,
      enumerable: true,
      value: choice.course.id,
      writable: false,
    });
  }
  labels.push(ADD_COURSE_LABEL);
  return frozen({
    action: 'courses',
    data: frozen({
      courseIdsByLabel: frozen(courseIdsByLabel),
      labels: frozen(labels),
    }),
    message: '과목을 선택해 주세요.',
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
  });
};

const readCatalog = async (dependencies, fileManager, root) => {
  const catalogPath = fileManager.joinPath(fileManager.joinPath(root, 'Catalog'), 'courses.json');
  const catalogSize = () => {
    const size = fileManager.fileSize(catalogPath);
    if (!Number.isSafeInteger(size) || size < 0) {
      invalid('CATALOG_INVALID');
    }
    return size;
  };
  try {
    if (!fileManager.fileExists(catalogPath)) {
      return frozen({ courses: frozen([]), generatedAt: null, protocolVersion: PROTOCOL_VERSION });
    }
    if (
      typeof fileManager.fileSize !== 'function' ||
      fileManager.isDirectory(catalogPath) ||
      typeof dependencies.dataFromString !== 'function'
    ) {
      invalid('CATALOG_INVALID');
    }
    const remoteSize = catalogSize();
    const remoteToken = observedFileSizeToken(fileManager, catalogPath);
    if (!observedTextSizeMayFit(fileManager, remoteSize, remoteToken, MAX_CATALOG_BYTES)) {
      invalid('CATALOG_INVALID');
    }
    if (
      typeof fileManager.isFileDownloaded === 'function' &&
      !fileManager.isFileDownloaded(catalogPath)
    ) {
      if (typeof fileManager.downloadFileFromiCloud !== 'function') invalid('CATALOG_INVALID');
      await fileManager.downloadFileFromiCloud(catalogPath);
      if (!fileManager.isFileDownloaded(catalogPath)) invalid('CATALOG_INVALID');
    }
    const beforeSize = catalogSize();
    const beforeToken = observedFileSizeToken(fileManager, catalogPath);
    if (!observedTextSizeMayFit(fileManager, beforeSize, beforeToken, MAX_CATALOG_BYTES)) {
      invalid('CATALOG_INVALID');
    }
    // Treat iCloud metadata as the download bound; a token transition is not a stable snapshot.
    if (beforeToken !== remoteToken) invalid('CATALOG_INVALID');
    const beforeModification = observedCoarseModificationToken(fileManager, catalogPath);
    if (beforeModification === null) invalid('CATALOG_INVALID');
    const rawCatalog = fileManager.readString(catalogPath);
    catalogSize();
    const afterToken = observedFileSizeToken(fileManager, catalogPath);
    const afterModification = observedCoarseModificationToken(fileManager, catalogPath);
    const exactSize = exactUtf8ByteLength(dependencies, rawCatalog);
    if (
      exactSize === null ||
      exactSize > MAX_CATALOG_BYTES ||
      afterToken === null ||
      beforeToken !== afterToken ||
      afterModification === null ||
      beforeModification !== afterModification ||
      (fileManager.fileSizeIsExact !== false && beforeSize !== exactSize)
    ) {
      invalid('CATALOG_INVALID');
    }
    return validateCourseCatalog(JSON.parse(rawCatalog));
  } catch (error) {
    if (error && error.message === 'CATALOG_INVALID') throw error;
    invalid('CATALOG_INVALID');
  }
};

const readCourseState = async (dependencies, fileManager, root) => {
  const catalog = await readCatalog(dependencies, fileManager, root);
  const pending = await discoverPendingCourses(dependencies, fileManager, root);
  return frozen({
    choices: mergeCourseChoices(catalog.courses, pending.courses),
    unavailableIds: frozen(catalog.courses.map((course) => course.id).concat(pending.ids)),
  });
};

const createCourseSelection = (dependencies, choices, unavailableIds, input) => {
  if (!hasExactKeys(input, ['name', 'professorName'])) invalid('INVALID_COURSE');
  const name = validateCourseDisplayText(input.name, 1, 80);
  const professorName = validateCourseDisplayText(input.professorName, 0, 80);
  const usedIds = new Set(Array.isArray(unavailableIds) ? unavailableIds : []);
  for (let index = 0; index < choices.length; index += 1) usedIds.add(choices[index].course.id);
  if (typeof dependencies.uuid !== 'function') invalid('INVALID_COURSE');
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const id = dependencies.uuid();
    if (!isUuid(id) || usedIds.has(id)) continue;
    return frozen({
      course: frozen({ id: id, name: name, professorName: professorName }),
      kind: 'create',
    });
  }
  invalid('INVALID_COURSE');
};

const selectCourse = async (dependencies, choices, unavailableIds) => {
  if (typeof dependencies.chooseCourse !== 'function') invalid('CATALOG_INVALID');
  const choice = await runRuntimeOperation('U01', () =>
    dependencies.chooseCourse(
      frozen(choices.map((entry) => entry.label).concat([ADD_COURSE_LABEL])),
    ),
  );
  if (choice === -1 || choice === null || choice === undefined) return null;
  if (!Number.isSafeInteger(choice) || choice < 0 || choice > choices.length) {
    invalid('CATALOG_INVALID');
  }
  if (choice < choices.length) {
    return frozen({ course: choices[choice].course, kind: choices[choice].kind });
  }
  if (typeof dependencies.promptCourse !== 'function') invalid('INVALID_COURSE');
  const input = await runRuntimeOperation('U02', () => dependencies.promptCourse());
  if (input === null || input === undefined) return null;
  return createCourseSelection(dependencies, choices, unavailableIds, input);
};

const createdAtFrom = (dependencies) => {
  const createdAt =
    typeof dependencies.clock === 'function' ? dependencies.clock() : new Date().toISOString();
  if (!isIsoWithOffset(createdAt)) invalid('QUEUE_WRITE_FAILED');
  return createdAt;
};

const reservationFileName = (jobId) => {
  if (!isUuid(jobId)) invalid('QUEUE_WRITE_FAILED');
  return `.reservation-${jobId}`;
};

const describeSources = async (fileManager, sourcePaths) => {
  if (
    !Array.isArray(sourcePaths) ||
    sourcePaths.length < 1 ||
    sourcePaths.length > MAX_SOURCES_PER_BUNDLE
  ) {
    invalid('INVALID_INPUT');
  }
  let totalBytes = 0;
  const sources = [];
  for (let index = 0; index < sourcePaths.length; index += 1) {
    const source = await describeSourcePath(fileManager, sourcePaths[index]);
    totalBytes += source.sizeBytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_BUNDLE_BYTES) {
      invalid('FILE_TOO_LARGE');
    }
    sources.push(source);
  }
  return frozen(sources);
};

const observeSourceSnapshot = async (fileManager, sourcePath) => {
  await ensureLocalFile(fileManager, sourcePath);
  const beforeSizeToken = observedFileSizeToken(fileManager, sourcePath);
  const beforeModificationToken = observedFileModificationToken(fileManager, sourcePath);
  if (beforeSizeToken === null || beforeModificationToken === null) {
    invalid('QUEUE_WRITE_FAILED');
  }
  const source = await describeSourcePath(fileManager, sourcePath);
  const afterSizeToken = observedFileSizeToken(fileManager, sourcePath);
  const afterModificationToken = observedFileModificationToken(fileManager, sourcePath);
  if (afterSizeToken !== beforeSizeToken || afterModificationToken !== beforeModificationToken) {
    invalid('QUEUE_WRITE_FAILED');
  }
  return frozen({
    modificationToken: afterModificationToken,
    path: sourcePath,
    sizeToken: afterSizeToken,
    source: source,
  });
};

const sourceSnapshotStillMatches = (fileManager, snapshot) =>
  fileManager.fileExists(snapshot.path) === true &&
  fileManager.isDirectory(snapshot.path) === false &&
  observedFileSizeToken(fileManager, snapshot.path) === snapshot.sizeToken &&
  observedFileModificationToken(fileManager, snapshot.path) === snapshot.modificationToken;

const copiedSourceMatches = async (fileManager, copiedPath, source) => {
  const copied = await observeSourceSnapshot(fileManager, copiedPath);
  if (
    copied.source.extension !== source.extension ||
    copied.source.mediaType !== source.mediaType ||
    copied.source.sizeBytes !== source.sizeBytes
  ) {
    invalid('QUEUE_WRITE_FAILED');
  }
  return copied;
};

const sourceFileName = (source, sourceId, ordinal) =>
  `${ordinal}-${sourceId}${source.extension || extensionFromFileName(source.fileName)}`;

const createSourceDescriptors = (dependencies, snapshots, jobId) => {
  if (typeof dependencies.uuid !== 'function') invalid('QUEUE_WRITE_FAILED');
  const usedIds = new Set();
  return frozen(
    snapshots.map((snapshot) => {
      let sourceId = null;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const candidate = dependencies.uuid();
        if (isUuid(candidate) && !usedIds.has(candidate)) {
          sourceId = candidate;
          break;
        }
      }
      if (sourceId === null) invalid('QUEUE_WRITE_FAILED');
      usedIds.add(sourceId);
      return frozen({
        fileName: safeDisplayFileName(snapshot.source.fileName, snapshot.source.extension, jobId),
        id: sourceId,
        mediaType: snapshot.source.mediaType,
        sizeBytes: snapshot.source.sizeBytes,
      });
    }),
  );
};

const bundleManifestsMatch = (left, right) => JSON.stringify(left) === JSON.stringify(right);

const observedBundleCommitState = (fileManager, jobPath, manifest) => {
  try {
    if (!fileManager.fileExists(jobPath)) return false;
    if (fileManager.isDirectory(jobPath) !== true) return null;
    const jobEntries = sortedBoundedDirectoryEntries(fileManager, jobPath, 3);
    if (
      jobEntries === null ||
      jobEntries.length !== 2 ||
      jobEntries[0] !== 'manifest.json' ||
      jobEntries[1] !== 'sources'
    ) {
      return null;
    }
    const manifestPath = fileManager.joinPath(jobPath, 'manifest.json');
    const sourcesPath = fileManager.joinPath(jobPath, 'sources');
    if (
      !fileManager.fileExists(manifestPath) ||
      fileManager.isDirectory(manifestPath) !== false ||
      !fileManager.fileExists(sourcesPath) ||
      fileManager.isDirectory(sourcesPath) !== true
    ) {
      return null;
    }
    const observedManifest = validateSourceBundleManifestV2(
      JSON.parse(fileManager.readString(manifestPath)),
    );
    if (!bundleManifestsMatch(observedManifest, manifest)) return null;
    const sourceEntries = sortedBoundedDirectoryEntries(
      fileManager,
      sourcesPath,
      MAX_SOURCES_PER_BUNDLE,
    );
    if (sourceEntries === null || sourceEntries.length !== manifest.sources.length) return null;
    for (let index = 0; index < manifest.sources.length; index += 1) {
      const source = manifest.sources[index];
      const extension = extensionFromFileName(source.fileName);
      const expectedName = sourceFileName(source, source.id, index);
      if (sourceEntries.indexOf(expectedName) === -1) return null;
      const copiedPath = fileManager.joinPath(sourcesPath, expectedName);
      if (
        !fileManager.fileExists(copiedPath) ||
        fileManager.isDirectory(copiedPath) !== false ||
        fileManager.fileSize(copiedPath) !== source.sizeBytes ||
        mediaTypeForExtension(extension) !== source.mediaType
      ) {
        return null;
      }
    }
    return true;
  } catch (_error) {
    return null;
  }
};

const leaseQueueJobDirectory = (dependencies, fileManager, root, directoryName) => {
  if (typeof dependencies.uuid !== 'function') invalid('QUEUE_WRITE_FAILED');
  const inboxPath = fileManager.joinPath(root, 'Inbox');
  const courseInboxPath = fileManager.joinPath(root, 'CourseInbox');
  const targetRoot = directoryName === 'Inbox' ? inboxPath : courseInboxPath;
  const markerPath = fileManager.joinPath(root, OWNER_MARKER_PATH);
  const rejectedPath = fileManager.joinPath(root, 'Rejected');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidate = dependencies.uuid();
    if (!isUuid(candidate)) invalid('QUEUE_WRITE_FAILED');
    const inboxCandidatePath = fileManager.joinPath(inboxPath, candidate);
    const courseCandidatePath = fileManager.joinPath(courseInboxPath, candidate);
    const inboxTemporaryPath = fileManager.joinPath(inboxPath, `.upload-${candidate}`);
    const courseTemporaryPath = fileManager.joinPath(courseInboxPath, `.upload-${candidate}`);
    const reservationPath = fileManager.joinPath(rejectedPath, reservationFileName(candidate));
    if (
      fileManager.fileExists(inboxCandidatePath) ||
      fileManager.fileExists(courseCandidatePath) ||
      fileManager.fileExists(inboxTemporaryPath) ||
      fileManager.fileExists(courseTemporaryPath) ||
      fileManager.fileExists(reservationPath)
    ) {
      continue;
    }
    try {
      fileManager.copy(markerPath, reservationPath);
    } catch (_reservationError) {
      continue;
    }
    if (
      fileManager.fileExists(inboxCandidatePath) ||
      fileManager.fileExists(courseCandidatePath) ||
      fileManager.fileExists(inboxTemporaryPath) ||
      fileManager.fileExists(courseTemporaryPath)
    ) {
      continue;
    }
    const jobPath = fileManager.joinPath(targetRoot, candidate);
    const temporaryPath = fileManager.joinPath(targetRoot, `.upload-${candidate}`);
    fileManager.createDirectory(temporaryPath);
    return frozen({ jobId: candidate, jobPath: jobPath, temporaryPath: temporaryPath });
  }
  invalid('QUEUE_WRITE_FAILED');
};

const writeSourceBundle = async (
  dependencies,
  fileManager,
  root,
  sourcePaths,
  courseId,
  courseProvisioning,
  directoryName,
) => {
  let lease = null;
  let manifest = null;
  try {
    lease = leaseQueueJobDirectory(dependencies, fileManager, root, directoryName);
    if (
      typeof fileManager.copy !== 'function' ||
      typeof fileManager.createDirectory !== 'function' ||
      typeof fileManager.move !== 'function' ||
      typeof fileManager.writeString !== 'function'
    ) {
      invalid('QUEUE_WRITE_FAILED');
    }
    const snapshots = [];
    let totalBytes = 0;
    for (let index = 0; index < sourcePaths.length; index += 1) {
      const snapshot = await observeSourceSnapshot(fileManager, sourcePaths[index]);
      totalBytes += snapshot.source.sizeBytes;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_BUNDLE_BYTES) {
        invalid('FILE_TOO_LARGE');
      }
      snapshots.push(snapshot);
    }
    const descriptors = createSourceDescriptors(dependencies, snapshots, lease.jobId);
    const sourcesPath = fileManager.joinPath(lease.temporaryPath, 'sources');
    fileManager.createDirectory(sourcesPath);
    const copiedSnapshots = [];
    for (let index = 0; index < snapshots.length; index += 1) {
      const snapshot = snapshots[index];
      const descriptor = descriptors[index];
      if (!sourceSnapshotStillMatches(fileManager, snapshot)) invalid('QUEUE_WRITE_FAILED');
      const copiedPath = fileManager.joinPath(
        sourcesPath,
        sourceFileName(snapshot.source, descriptor.id, index),
      );
      fileManager.copy(snapshot.path, copiedPath);
      const copiedSnapshot = await copiedSourceMatches(fileManager, copiedPath, snapshot.source);
      if (!sourceSnapshotStillMatches(fileManager, snapshot)) invalid('QUEUE_WRITE_FAILED');
      copiedSnapshots.push(copiedSnapshot);
    }
    for (let index = 0; index < snapshots.length; index += 1) {
      if (
        !sourceSnapshotStillMatches(fileManager, snapshots[index]) ||
        !sourceSnapshotStillMatches(fileManager, copiedSnapshots[index])
      ) {
        invalid('QUEUE_WRITE_FAILED');
      }
    }
    manifest = validateSourceBundleManifestV2({
      courseId: courseId,
      ...(courseProvisioning === null ? {} : { courseProvisioning: courseProvisioning }),
      createdAt: createdAtFrom(dependencies),
      jobId: lease.jobId,
      protocolVersion: SOURCE_BUNDLE_PROTOCOL_VERSION,
      sources: descriptors,
      summaryMode: 'standard',
    });
    const rawManifest = JSON.stringify(manifest);
    const manifestBytes = exactUtf8ByteLength(dependencies, rawManifest);
    if (manifestBytes === null || manifestBytes > MAX_COURSE_REQUEST_BYTES) {
      invalid('QUEUE_WRITE_FAILED');
    }
    fileManager.writeString(
      fileManager.joinPath(lease.temporaryPath, 'manifest.json'),
      rawManifest,
    );
    fileManager.move(lease.temporaryPath, lease.jobPath);
    return enqueueSuccess(lease.jobId);
  } catch (error) {
    if (
      lease !== null &&
      manifest !== null &&
      observedBundleCommitState(fileManager, lease.jobPath, manifest) === true
    ) {
      return enqueueSuccess(lease.jobId);
    }
    if (
      lease !== null &&
      typeof fileManager.remove === 'function' &&
      fileManager.fileExists(lease.temporaryPath)
    ) {
      try {
        fileManager.remove(lease.temporaryPath);
      } catch (_cleanupError) {
        // Cleanup is limited to this invocation's hidden, unpublished directory.
      }
    }
    if (
      error &&
      (error.message === 'UNSUPPORTED_SOURCE' ||
        error.message === 'SOURCE_TOO_LARGE' ||
        error.message === 'FILE_TOO_LARGE')
    ) {
      throw error;
    }
    invalid('QUEUE_WRITE_FAILED');
  }
};

const sameCourseDefinition = (left, right) =>
  left.id === right.id && left.name === right.name && left.professorName === right.professorName;

const writeSelectedQueueJob = async (
  dependencies,
  fileManager,
  root,
  sourcePaths,
  selection,
  missingSelectionCode,
) => {
  const selectionFailureCode = missingSelectionCode || 'CATALOG_INVALID';
  const refreshedCatalog = await readCatalog(dependencies, fileManager, root);
  const canonical = refreshedCatalog.courses.filter(
    (course) => course.id === selection.course.id,
  )[0];
  if (canonical) {
    return writeSourceBundle(
      dependencies,
      fileManager,
      root,
      sourcePaths,
      canonical.id,
      null,
      'Inbox',
    );
  }
  if (selection.kind === 'catalog') invalid(selectionFailureCode);
  const refreshedPending = await discoverPendingCourses(dependencies, fileManager, root);
  const pendingCourse = refreshedPending.courses.filter(
    (course) => course.id === selection.course.id,
  )[0];
  if (selection.kind === 'pending') {
    if (!pendingCourse || !sameCourseDefinition(pendingCourse, selection.course)) {
      invalid(selectionFailureCode);
    }
  } else if (refreshedPending.ids.indexOf(selection.course.id) !== -1) {
    invalid('CATALOG_INVALID');
  }
  const finalCatalog = await readCatalog(dependencies, fileManager, root);
  const finalCanonical = finalCatalog.courses.filter(
    (course) => course.id === selection.course.id,
  )[0];
  if (finalCanonical) {
    return writeSourceBundle(
      dependencies,
      fileManager,
      root,
      sourcePaths,
      finalCanonical.id,
      null,
      'Inbox',
    );
  }
  return writeSourceBundle(
    dependencies,
    fileManager,
    root,
    sourcePaths,
    selection.course.id,
    selection.course,
    'CourseInbox',
  );
};

const courses = async (dependencies, fileManager) => {
  const root = fileManager.documentsDirectory();
  const state = await readCourseState(dependencies, fileManager, root);
  return courseOptionsSuccess(state.choices);
};

const enqueue = async (dependencies, fileManager, invocation) => {
  const sourcePaths = invocation.sourcePaths;
  await runRuntimeOperation('E01', () => describeSources(fileManager, sourcePaths));
  const root = fileManager.documentsDirectory();
  const state = await readCourseState(dependencies, fileManager, root);
  let selection;
  let missingSelectionCode;
  if (typeof invocation.courseId === 'string') {
    const matchingChoice = state.choices.filter(
      (choice) => choice.course.id === invocation.courseId,
    )[0];
    if (!matchingChoice) invalid('COURSE_SELECTION_STALE');
    selection = frozen({ course: matchingChoice.course, kind: matchingChoice.kind });
    missingSelectionCode = 'COURSE_SELECTION_STALE';
  } else if (invocation.newCourse) {
    selection = createCourseSelection(
      dependencies,
      state.choices,
      state.unavailableIds,
      invocation.newCourse,
    );
  } else {
    selection = await selectCourse(dependencies, state.choices, state.unavailableIds);
  }
  if (selection === null) return enqueueCancellation();
  return writeSelectedQueueJob(
    dependencies,
    fileManager,
    root,
    sourcePaths,
    selection,
    missingSelectionCode,
  );
};

function createStudyAssistant(dependencies) {
  const configuredDependencies = dependencies || frozen({});
  const resolveFileManager = () => {
    if (configuredDependencies.fileManager) return configuredDependencies.fileManager;
    if (typeof configuredDependencies.getFileManager === 'function') {
      return configuredDependencies.getFileManager();
    }
    queueRootConflict('R18');
  };
  const run = async (input) => {
    try {
      const invocation = parseInvocation(input);
      if (invocation.ok === false) return invocation;
      const fileManager = await runRuntimeOperation('F01', resolveFileManager);
      await runRuntimeOperation('F02', () => ensureOwnedQueue(fileManager));
      if (invocation.action === 'enqueue') {
        return await enqueue(configuredDependencies, fileManager, invocation);
      }
      if (invocation.action === 'courses')
        return await courses(configuredDependencies, fileManager);
      return await aggregateStatus(configuredDependencies, fileManager);
    } catch (error) {
      return publicFailure(internalFailureCode(error));
    }
  };
  return frozen({
    failedReceiptMessages: APP_ERROR_MESSAGES,
    run: run,
    validateSource: validateSource,
  });
}

async function runScriptableRuntime(globals) {
  const runtime = isPlainObject(globals) ? globals : frozen({});
  const script = runtime.Script;
  let result = publicFailure('UNEXPECTED_ERROR');
  try {
    const runtimeArgs = runtime.args;
    const dataFromString =
      runtime.Data && typeof runtime.Data.fromString === 'function'
        ? (text) => runtime.Data.fromString(text)
        : null;
    const getFileManager =
      runtime.FileManager && typeof runtime.FileManager.iCloud === 'function'
        ? async () =>
            calibratedRuntimeFileManager(
              await Promise.resolve(runtime.FileManager.iCloud()),
              dataFromString,
            )
        : null;
    const createAlert =
      typeof runtime.createAlert === 'function'
        ? () => runtime.createAlert()
        : runtime.Alert
          ? () => new runtime.Alert()
          : null;
    const createCoursePicker = (names) => {
      const picker = runRuntimeOperationSync('U111', () => createAlert());
      runRuntimeOperationSync('U112', () => {
        for (let index = 0; index < names.length; index += 1) picker.addAction(names[index]);
      });
      runRuntimeOperationSync('U113', () => picker.addCancelAction('취소'));
      return picker;
    };
    const chooseCourse = async (names) => {
      if (!createAlert) return -1;
      const picker = createCoursePicker(names);
      try {
        return await picker.presentSheet();
      } catch (error) {
        if (internalFailureCode(error) !== null) throw error;
        const fallbackPicker = createCoursePicker(names);
        return runRuntimeOperation('U13', () => fallbackPicker.presentAlert());
      }
    };
    const promptCourse = async () => {
      if (!createAlert) return null;
      const form = runRuntimeOperationSync('U02', () => createAlert());
      form.title = '새 과목 추가';
      form.message = '현재 강의와 함께 생성 요청을 보냅니다.';
      form.addTextField('과목명');
      form.addTextField('교수 표시명 (선택)');
      form.addAction('추가하고 보내기');
      form.addCancelAction('취소');
      if ((await form.presentAlert()) === -1) return null;
      return frozen({
        name: form.textFieldValue(0),
        professorName: form.textFieldValue(1),
      });
    };
    const assistant = createStudyAssistant(
      frozen({
        chooseCourse: chooseCourse,
        clock: () => new Date().toISOString(),
        dataFromBytes:
          runtime.Data && typeof runtime.Data.fromBytes === 'function'
            ? (bytes) => runtime.Data.fromBytes(bytes)
            : null,
        dataFromString: dataFromString,
        getFileManager: getFileManager,
        promptCourse: promptCourse,
        uuid:
          runtime.UUID && typeof runtime.UUID.string === 'function'
            ? () => runtime.UUID.string()
            : null,
      }),
    );
    const input = frozen({
      fileURLs: runtimeArgs && Array.isArray(runtimeArgs.fileURLs) ? runtimeArgs.fileURLs : [],
      shortcutParameter: runtimeArgs ? runtimeArgs.shortcutParameter : null,
    });
    result = invocationDiagnosticFailure(await assistant.run(input), runtimeArgs);
  } catch (_error) {
    result = publicFailure('UNEXPECTED_ERROR');
  }
  try {
    if (script && typeof script.setShortcutOutput === 'function') {
      await Promise.resolve(script.setShortcutOutput(result));
    }
  } catch (_error) {
    // Shortcut publication is intentionally not retried.
  } finally {
    try {
      if (script && typeof script.complete === 'function') {
        await Promise.resolve(script.complete());
      }
    } catch (_error) {
      // Platform completion exceptions are not allowed to leave the auto-run boundary.
    }
  }
  return result;
}

const exportedApi = Object.freeze({
  createStudyAssistant,
  mediaTypeForExtension,
  parseInvocation,
  runScriptableRuntime,
  safeDisplayFileName,
  selectCourse,
  validateCourseCatalog,
  validateCourseInboxRequest,
  validateCourseProvisioningInput,
  validateStatusReceipt,
});

if (typeof module !== 'undefined' && module.exports) {
  module.exports = exportedApi;
}

if (typeof FileManager !== 'undefined' && typeof Script !== 'undefined') {
  await runScriptableRuntime({
    createAlert: () => new Alert(),
    Data,
    FileManager,
    Script,
    UUID,
    args,
  });
}
