import { createHash } from 'node:crypto';
import { lstatSync, type Stats } from 'node:fs';
import { win32 as path } from 'node:path';
import {
  isSafeWindowsPathSegment,
  isWindowsDeviceName,
  isWindowsForbiddenCharacter,
} from '../../shared/contracts/windowsPath';
import { APP_ERROR_MESSAGES, AppError } from '../../shared/errors';

const WINDOWS_DEVICE_NAMESPACE = /^\\\\[.?]\\/u;
const MAX_COURSE_FOLDER_LENGTH = 100;

const throwSafePath = (): never => {
  throw new AppError('SAFE_PATH', APP_ERROR_MESSAGES.SAFE_PATH);
};

const validateManagedSegment = (segment: string): void => {
  if (!isSafeWindowsPathSegment(segment) || path.isAbsolute(segment)) {
    throwSafePath();
  }
};

const isMissingPathError = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

const isUnsupportedRootNamespace = (absolutePath: string): boolean => {
  const normalizedSeparators = absolutePath.replaceAll('/', '\\');
  return (
    WINDOWS_DEVICE_NAMESPACE.test(normalizedSeparators) ||
    path.parse(normalizedSeparators).root.startsWith('\\\\')
  );
};

export const assertNoReparsePoints = (targetPath: string): void => {
  if (!path.isAbsolute(targetPath) || isUnsupportedRootNamespace(targetPath)) {
    throwSafePath();
  }

  const normalizedTarget = path.resolve(targetPath);
  const parsedTarget = path.parse(normalizedTarget);
  const relativeTarget = path.relative(parsedTarget.root, normalizedTarget);
  let currentPath = parsedTarget.root;

  for (const component of relativeTarget.split(path.sep).filter(Boolean)) {
    currentPath = path.join(currentPath, component);

    let stats: Stats | undefined;
    try {
      stats = lstatSync(currentPath);
    } catch (error) {
      if (isMissingPathError(error)) {
        return;
      }
      throwSafePath();
    }

    if (!stats || stats.isSymbolicLink()) {
      throwSafePath();
    }
  }
};

export const resolveManagedPath = (root: string, ...segments: readonly string[]): string => {
  if (
    !path.isAbsolute(root) ||
    root.includes('\0') ||
    isUnsupportedRootNamespace(root) ||
    segments.length === 0
  ) {
    throwSafePath();
  }

  for (const segment of segments) {
    validateManagedSegment(segment);
  }

  const normalizedRoot = path.resolve(root);
  const parsedRoot = path.parse(normalizedRoot);
  const relativeRoot = path.relative(parsedRoot.root, normalizedRoot);
  if (relativeRoot === '') {
    throwSafePath();
  }
  for (const component of relativeRoot.split(path.sep).filter(Boolean)) {
    validateManagedSegment(component);
  }

  const candidate = path.resolve(normalizedRoot, ...segments);
  const relative = path.relative(normalizedRoot, candidate);

  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throwSafePath();
  }

  assertNoReparsePoints(normalizedRoot);
  assertNoReparsePoints(candidate);

  return candidate;
};

export const toSafeCourseFolder = (name: string): string => {
  const separatorsReplaced = name.replace(/[\\/]+/gu, ' - ');
  const readable = Array.from(separatorsReplaced)
    .map((character) => (isWindowsForbiddenCharacter(character) ? ' ' : character))
    .join('')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[. ]+$/u, '');

  const fallback = readable.length === 0 ? '새 과목' : readable;
  const deviceSafe = isWindowsDeviceName(fallback) ? `${fallback} 과목` : fallback;
  if (deviceSafe.length <= MAX_COURSE_FOLDER_LENGTH) {
    return deviceSafe;
  }

  const digest = createHash('sha256').update(deviceSafe, 'utf8').digest('hex').slice(0, 10);
  const suffix = `-${digest}`;
  const prefixBudget = MAX_COURSE_FOLDER_LENGTH - suffix.length;
  let prefix = '';
  for (const character of Array.from(deviceSafe)) {
    if (prefix.length + character.length > prefixBudget) {
      break;
    }
    prefix += character;
  }
  return `${prefix.replace(/[. ]+$/u, '')}${suffix}`;
};
