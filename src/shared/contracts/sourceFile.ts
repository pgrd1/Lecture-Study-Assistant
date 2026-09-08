import { createSafeWindowsPathSegmentSchema } from './windowsPath';

export const SUPPORTED_EXTENSIONS = [
  '.m4a',
  '.mp3',
  '.wav',
  '.aac',
  '.flac',
  '.mp4',
  '.pdf',
  '.pptx',
  '.txt',
  '.md',
  '.png',
  '.jpg',
  '.jpeg',
  '.heic',
] as const;

const SUPPORTED_EXTENSION_SET = new Set<string>(SUPPORTED_EXTENSIONS);

const WINDOWS_DEVICE_NAME_PATTERN =
  '(?:[cC][oO][nN]|[pP][rR][nN]|[aA][uU][xX]|[nN][uU][lL]|[cC][oO][mM][1-9¹²³]|[lL][pP][tT][1-9¹²³]|[cC][oO][nN][iI][nN]\\$|[cC][oO][nN][oO][uU][tT]\\$)';

const caseInsensitiveExtension = (extension: string): string =>
  Array.from(extension.slice(1))
    .map((character) =>
      /[a-z]/u.test(character) ? `[${character}${character.toUpperCase()}]` : character,
    )
    .join('');

export const sourceFileNameJsonPattern = (extensions: readonly string[]): string => {
  const allowedExtensions = extensions.map(caseInsensitiveExtension).join('|');
  return `^(?![.]{1,2}$)(?!${WINDOWS_DEVICE_NAME_PATTERN}[ ]*(?:[.]|$))(?!.*[<>:"/\\\\|?*\\u0000-\\u001F\\u007F-\\u009F])(?=.{1,180}$)(?=.*[^.\\s].*[.](?:${allowedExtensions})$).+$`;
};

export const extensionOf = (fileName: string): string => {
  const dotIndex = fileName.lastIndexOf('.');
  return dotIndex < 0 ? '' : fileName.slice(dotIndex).toLowerCase();
};

const hasSafeStem = (fileName: string): boolean => {
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex <= 0) {
    return false;
  }

  const stem = fileName.slice(0, dotIndex);
  return /[^.\s]/u.test(stem);
};

export const SupportedSourceFileNameSchema = createSafeWindowsPathSegmentSchema(180)
  .refine((value) => value.trim().length > 0, '파일명이 필요합니다.')
  .refine(hasSafeStem, '확장자 앞에 파일명이 필요합니다.')
  .refine((value) => SUPPORTED_EXTENSION_SET.has(extensionOf(value)), '지원하지 않는 파일입니다.')
  .meta({ pattern: sourceFileNameJsonPattern(SUPPORTED_EXTENSIONS) });

export const createMediaSourceFileNameSchema = (extensions: readonly string[]) => {
  const allowed = new Set(extensions);
  return SupportedSourceFileNameSchema.refine(
    (value) => allowed.has(extensionOf(value)),
    '파일 확장자와 미디어 유형이 일치하지 않습니다.',
  ).meta({ pattern: sourceFileNameJsonPattern(extensions) });
};
