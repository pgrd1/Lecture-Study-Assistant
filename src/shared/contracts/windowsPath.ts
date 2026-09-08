import { z } from 'zod';

const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)$/iu;
const WINDOWS_FORBIDDEN_CHARACTERS = '<>:"/\\|?*';

export const isWindowsForbiddenCharacter = (character: string): boolean => {
  const codePoint = character.codePointAt(0) ?? 0;
  return (
    codePoint <= 31 ||
    (codePoint >= 127 && codePoint <= 159) ||
    WINDOWS_FORBIDDEN_CHARACTERS.includes(character)
  );
};

export const containsWindowsForbiddenCharacter = (value: string): boolean =>
  Array.from(value).some(isWindowsForbiddenCharacter);

export const isWindowsDeviceName = (value: string): boolean => {
  const firstComponent = value.split('.', 1)[0]?.trimEnd() ?? '';
  return WINDOWS_DEVICE_NAME.test(firstComponent);
};

export const isSafeWindowsPathSegment = (value: string): boolean =>
  value.length > 0 &&
  value !== '.' &&
  value !== '..' &&
  !containsWindowsForbiddenCharacter(value) &&
  !/[. ]$/u.test(value) &&
  !isWindowsDeviceName(value);

export const createSafeWindowsPathSegmentSchema = (maximumLength: number) =>
  z
    .string()
    .min(1)
    .max(maximumLength)
    .refine(isSafeWindowsPathSegment, 'Windows에서 안전한 단일 경로 구간이어야 합니다.');
