import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import type { ProviderConnectionOperation } from '../../../core/ports/aiProvider';
import { APP_ERROR_MESSAGES, AppError } from '../../../shared/errors';

export const SHA_256_PATTERN = /^[a-f0-9]{64}$/u;
export const PACKAGE_MANIFEST_LIMIT_BYTES = 128 * 1024;

export interface CliExecutableFileAccess {
  canonicalize(path: string, operation: ProviderConnectionOperation): Promise<string>;
  assertNoReparsePoints(path: string, operation: ProviderConnectionOperation): Promise<void>;
  readFile(
    path: string,
    limitBytes: number,
    operation: ProviderConnectionOperation,
  ): Promise<Uint8Array>;
  listChildren(path: string, operation: ProviderConnectionOperation): Promise<readonly string[]>;
}

export interface CliFileHasher {
  sha256(path: string, operation: ProviderConnectionOperation): Promise<string>;
}

export type FileIntegrityDependencies = Readonly<{
  files: CliExecutableFileAccess;
  hasher: CliFileHasher;
}>;

export type ManifestSnapshot = Readonly<{
  text: string;
  sha256: string;
}>;

export const unsafeVersion = (): AppError =>
  new AppError('PROVIDER_UNSAFE_VERSION', APP_ERROR_MESSAGES.PROVIDER_UNSAFE_VERSION);

const residualData = (): AppError =>
  new AppError('PROVIDER_RESIDUAL_DATA', APP_ERROR_MESSAGES.PROVIDER_RESIDUAL_DATA);

export const runCliCleanupWithinDeadline = async <T>(
  operation: ProviderConnectionOperation,
  action: () => Promise<T>,
): Promise<T> => {
  if (operation.signal.aborted) throw residualData();
  const pending = Promise.resolve().then(action);
  void pending.catch(() => undefined);
  let removeAbortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => reject(residualData());
    operation.signal.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = () => operation.signal.removeEventListener('abort', onAbort);
    if (operation.signal.aborted) onAbort();
  });
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    removeAbortListener?.();
  }
};

export const assertProviderConnectionActive = (operation: ProviderConnectionOperation): void => {
  if (operation.signal.aborted) {
    throw new AppError('PROVIDER_CANCELLED', APP_ERROR_MESSAGES.PROVIDER_CANCELLED);
  }
};

export const isCanonicalAbsoluteWindowsPath = (path: string): boolean =>
  path.length >= 3 &&
  path.length <= 32_767 &&
  !/[\p{Cc}\p{Cf}]/u.test(path) &&
  /^[A-Za-z]:\\/u.test(path) &&
  win32.isAbsolute(path) &&
  win32.normalize(path) === path;

export const sameWindowsPath = (left: string, right: string): boolean =>
  win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();

export const isDirectChild = (root: string, child: string): boolean =>
  sameWindowsPath(win32.dirname(child), root) && !sameWindowsPath(child, root);

export const isContained = (root: string, path: string): boolean => {
  const relative = win32.relative(root, path);
  return (
    relative.length > 0 &&
    !relative.startsWith('..') &&
    !win32.isAbsolute(relative) &&
    !relative.split(/[\\/]/u).includes('..')
  );
};

export const isMissingPathError = (error: unknown): boolean =>
  (error instanceof Error && error.message === 'ENOENT') ||
  (error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    ((error as { readonly code?: unknown }).code === 'ENOENT' ||
      (error as { readonly code?: unknown }).code === 'ENOTDIR'));

export const canonicalizeSecure = async (
  files: CliExecutableFileAccess,
  path: string,
  operation: ProviderConnectionOperation,
): Promise<string> => {
  assertProviderConnectionActive(operation);
  if (!isCanonicalAbsoluteWindowsPath(path)) throw unsafeVersion();
  await files.assertNoReparsePoints(path, operation);
  assertProviderConnectionActive(operation);
  const canonical = await files.canonicalize(path, operation);
  assertProviderConnectionActive(operation);
  if (!isCanonicalAbsoluteWindowsPath(canonical)) throw unsafeVersion();
  await files.assertNoReparsePoints(canonical, operation);
  assertProviderConnectionActive(operation);
  return canonical;
};

export const secureExactPath = async (
  files: CliExecutableFileAccess,
  path: string,
  operation: ProviderConnectionOperation,
): Promise<string> => {
  assertProviderConnectionActive(operation);
  const canonical = await canonicalizeSecure(files, path, operation);
  assertProviderConnectionActive(operation);
  if (!sameWindowsPath(canonical, path)) throw unsafeVersion();
  return canonical;
};

export const secureExpectedPath = async (
  files: CliExecutableFileAccess,
  path: string,
  root: string,
  operation: ProviderConnectionOperation,
): Promise<string> => {
  assertProviderConnectionActive(operation);
  if (!isContained(root, path)) throw unsafeVersion();
  const canonical = await canonicalizeSecure(files, path, operation);
  assertProviderConnectionActive(operation);
  if (!sameWindowsPath(canonical, path) || !isContained(root, canonical)) {
    throw unsafeVersion();
  }
  return canonical;
};

export const hashSecureFile = async (
  dependencies: FileIntegrityDependencies,
  path: string,
  operation: ProviderConnectionOperation,
): Promise<string> => {
  assertProviderConnectionActive(operation);
  await dependencies.files.assertNoReparsePoints(path, operation);
  assertProviderConnectionActive(operation);
  const hash = await dependencies.hasher.sha256(path, operation);
  assertProviderConnectionActive(operation);
  if (!SHA_256_PATTERN.test(hash)) throw unsafeVersion();
  return hash;
};

export const readManifestSnapshot = async (
  files: CliExecutableFileAccess,
  path: string,
  operation: ProviderConnectionOperation,
): Promise<ManifestSnapshot> => {
  assertProviderConnectionActive(operation);
  await files.assertNoReparsePoints(path, operation);
  assertProviderConnectionActive(operation);
  const source = await files.readFile(path, PACKAGE_MANIFEST_LIMIT_BYTES, operation);
  assertProviderConnectionActive(operation);
  if (source.byteLength === 0 || source.byteLength > PACKAGE_MANIFEST_LIMIT_BYTES) {
    throw unsafeVersion();
  }
  const bytes = Uint8Array.from(source);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw unsafeVersion();
  }
  return Object.freeze({
    text,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
};
