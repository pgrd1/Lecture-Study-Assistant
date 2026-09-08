import type { CliCredentialScopeFor, CliRuntimeBinding } from '../../../core/ports/aiProvider';
import { sha256CanonicalJson } from '../../../core/providers/canonicalJson';
import {
  type CliProviderId,
  parseSafeSemVer,
  type SafeSemVer,
  TRUSTED_CLI_BINDING_RECIPES,
} from '../../../shared/contracts/provider';
import { isCanonicalAbsoluteWindowsPath, SHA_256_PATTERN, unsafeVersion } from './cliFileIntegrity';
import type { CliSignerClassification } from './windowsAuthenticodeVerifier';

const STABLE_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

export const SUPPORTED_CLI_RECIPES = Object.freeze({
  antigravity_cli: Object.freeze({
    ...TRUSTED_CLI_BINDING_RECIPES.antigravity_cli,
    minimumVersion: '1.1.12',
    maximumExclusiveVersion: '1.2.0',
    versionArgs: Object.freeze(['--version'] as const),
    credentialScope: 'provider_global' as const,
  }),
  gemini_cli: Object.freeze({
    ...TRUSTED_CLI_BINDING_RECIPES.gemini_cli,
    minimumVersion: '0.55.1',
    maximumExclusiveVersion: '0.56.0',
    versionArgs: Object.freeze(['--version'] as const),
    credentialScope: 'provider_global' as const,
  }),
  codex_cli: Object.freeze({
    ...TRUSTED_CLI_BINDING_RECIPES.codex_cli,
    minimumVersion: '0.146.0',
    maximumExclusiveVersion: '0.147.0',
    versionArgs: Object.freeze(['--version'] as const),
    credentialScope: 'profile_scoped' as const,
  }),
} as const);

export type CandidateKind = 'antigravity_native' | 'gemini_npm' | 'codex_native' | 'codex_npm';

export type CandidateCapture = Readonly<{
  providerId: CliProviderId;
  kind: CandidateKind;
  canonicalLauncherPath: string;
  canonicalEntryPath: string | null;
  canonicalPackageManifestPath: string | null;
  canonicalPlatformPackageManifestPath: string | null;
  fixedPrefixArgs: readonly string[];
  launcherSha256: string;
  entrySha256: string | null;
  packageManifestSha256: string | null;
  platformPackageManifestSha256: string | null;
  signerClassification: CliSignerClassification;
  packageVersion: string | null;
}>;

export type ParsedPackage = Readonly<{
  name: string;
  version: string;
  entry: string;
}>;

const versionParts = (version: string): readonly bigint[] | null => {
  if (!STABLE_VERSION_PATTERN.test(version)) return null;
  return Object.freeze(version.split('.').map((part) => BigInt(part)));
};

const compareVersions = (left: string, right: string): number => {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  if (leftParts === null || rightParts === null) throw unsafeVersion();
  for (let index = 0; index < 3; index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart === undefined || rightPart === undefined) throw unsafeVersion();
    if (leftPart < rightPart) return -1;
    if (leftPart > rightPart) return 1;
  }
  return 0;
};

export const isVersionSupported = (providerId: CliProviderId, version: string): boolean => {
  const recipe = SUPPORTED_CLI_RECIPES[providerId];
  return (
    versionParts(version) !== null &&
    compareVersions(version, recipe.minimumVersion) >= 0 &&
    compareVersions(version, recipe.maximumExclusiveVersion) < 0
  );
};

const ownDataValue = (object: Record<string, unknown>, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
    throw unsafeVersion();
  }
  return descriptor.value;
};

const parseJsonObject = (text: string): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw unsafeVersion();
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.getPrototypeOf(parsed) !== Object.prototype
  ) {
    throw unsafeVersion();
  }
  return parsed as Record<string, unknown>;
};

export const parsePackageManifest = (
  text: string,
  expectedName: string,
  expectedCommand: string,
): ParsedPackage => {
  const parsed = parseJsonObject(text);
  const name = ownDataValue(parsed, 'name');
  const version = ownDataValue(parsed, 'version');
  const bin = ownDataValue(parsed, 'bin');
  if (
    name !== expectedName ||
    typeof version !== 'string' ||
    !STABLE_VERSION_PATTERN.test(version) ||
    bin === null ||
    typeof bin !== 'object' ||
    Array.isArray(bin) ||
    Object.getPrototypeOf(bin) !== Object.prototype
  ) {
    throw unsafeVersion();
  }
  const binObject = bin as Record<string, unknown>;
  const binKeys = Object.keys(binObject);
  const entry = ownDataValue(binObject, expectedCommand);
  if (binKeys.length !== 1 || binKeys[0] !== expectedCommand || typeof entry !== 'string') {
    throw unsafeVersion();
  }
  const normalizedEntry = entry.replaceAll('/', '\\');
  if (
    entry.length === 0 ||
    entry.length > 1_024 ||
    /[\p{Cc}\p{Cf}]/u.test(entry) ||
    !/\.(?:cjs|js|mjs)$/u.test(normalizedEntry) ||
    normalizedEntry.split('\\').includes('..') ||
    /^[A-Za-z]:\\/u.test(normalizedEntry)
  ) {
    throw unsafeVersion();
  }
  return Object.freeze({ name, version, entry: normalizedEntry });
};

export const parsePlatformManifest = (
  text: string,
  expectedName: string,
  expectedVersion: string,
  expectedArchitecture: 'x64' | 'arm64',
): void => {
  const parsed = parseJsonObject(text);
  const name = ownDataValue(parsed, 'name');
  const version = ownDataValue(parsed, 'version');
  const os = ownDataValue(parsed, 'os');
  const cpu = ownDataValue(parsed, 'cpu');
  if (
    name !== expectedName ||
    version !== expectedVersion ||
    !Array.isArray(os) ||
    os.length !== 1 ||
    os[0] !== 'win32' ||
    !Array.isArray(cpu) ||
    cpu.length !== 1 ||
    cpu[0] !== expectedArchitecture ||
    Reflect.ownKeys(os).length !== 2 ||
    Reflect.ownKeys(cpu).length !== 2
  ) {
    throw unsafeVersion();
  }
};

export const parseVersionOutput = (providerId: CliProviderId, stdout: string): string => {
  const patterns: Readonly<Record<CliProviderId, RegExp>> = Object.freeze({
    antigravity_cli: /^agy ((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:\r?\n)?$/u,
    gemini_cli: /^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:\r?\n)?$/u,
    codex_cli: /^codex-cli ((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:\r?\n)?$/u,
  });
  const version = patterns[providerId].exec(stdout)?.[1];
  if (version === undefined || !isVersionSupported(providerId, version)) throw unsafeVersion();
  return version;
};

export const expectedPrefix = (
  providerId: CliProviderId,
  canonicalEntryPath: string | null,
): readonly string[] => {
  const prefix = TRUSTED_CLI_BINDING_RECIPES[providerId].launcherPrefix;
  if (prefix === 'none') return Object.freeze([]);
  if (canonicalEntryPath === null) throw unsafeVersion();
  return Object.freeze([canonicalEntryPath]);
};

export const bindingHash = (identity: {
  readonly providerId: CliProviderId;
  readonly version: string;
  readonly recipeId: string;
  readonly credentialScope: 'profile_scoped' | 'provider_global';
  readonly signerClassification: CliSignerClassification;
  readonly launcherSha256: string;
  readonly entrySha256: string | null;
  readonly packageManifestSha256: string | null;
  readonly platformPackageManifestSha256: string | null;
}): string =>
  sha256CanonicalJson({
    providerId: identity.providerId,
    version: identity.version,
    recipeId: identity.recipeId,
    credentialScope: identity.credentialScope,
    signerClassification: identity.signerClassification,
    launcherSha256: identity.launcherSha256,
    entrySha256: identity.entrySha256,
    packageManifestSha256: identity.packageManifestSha256,
    platformPackageManifestSha256: identity.platformPackageManifestSha256,
  });

const paired = (left: unknown, right: unknown): boolean => (left === null) === (right === null);

export const assertCaptureShape = (capture: CandidateCapture): void => {
  const entryPresent = capture.canonicalEntryPath !== null;
  const manifestPresent = capture.canonicalPackageManifestPath !== null;
  const platformPresent = capture.canonicalPlatformPackageManifestPath !== null;
  const commonValid =
    isCanonicalAbsoluteWindowsPath(capture.canonicalLauncherPath) &&
    SHA_256_PATTERN.test(capture.launcherSha256) &&
    paired(capture.canonicalEntryPath, capture.entrySha256) &&
    paired(capture.canonicalPackageManifestPath, capture.packageManifestSha256) &&
    paired(capture.canonicalPlatformPackageManifestPath, capture.platformPackageManifestSha256) &&
    capture.fixedPrefixArgs.length ===
      expectedPrefix(capture.providerId, capture.canonicalEntryPath).length &&
    capture.fixedPrefixArgs.every(
      (argument, index) =>
        argument === expectedPrefix(capture.providerId, capture.canonicalEntryPath)[index],
    );
  const matrixValid =
    (capture.kind === 'antigravity_native' &&
      capture.providerId === 'antigravity_cli' &&
      capture.signerClassification === 'google' &&
      !entryPresent &&
      !manifestPresent &&
      !platformPresent) ||
    (capture.kind === 'codex_native' &&
      capture.providerId === 'codex_cli' &&
      capture.signerClassification === 'openai' &&
      !entryPresent &&
      !manifestPresent &&
      !platformPresent) ||
    (capture.kind === 'gemini_npm' &&
      capture.providerId === 'gemini_cli' &&
      capture.signerClassification === 'nodejs' &&
      entryPresent &&
      manifestPresent &&
      !platformPresent) ||
    (capture.kind === 'codex_npm' &&
      capture.providerId === 'codex_cli' &&
      capture.signerClassification === 'openai' &&
      entryPresent &&
      manifestPresent &&
      platformPresent);
  if (!commonValid || !matrixValid) throw unsafeVersion();
};

export const sameCapture = (left: CandidateCapture, right: CandidateCapture): boolean =>
  left.providerId === right.providerId &&
  left.kind === right.kind &&
  left.canonicalLauncherPath === right.canonicalLauncherPath &&
  left.canonicalEntryPath === right.canonicalEntryPath &&
  left.canonicalPackageManifestPath === right.canonicalPackageManifestPath &&
  left.canonicalPlatformPackageManifestPath === right.canonicalPlatformPackageManifestPath &&
  left.launcherSha256 === right.launcherSha256 &&
  left.entrySha256 === right.entrySha256 &&
  left.packageManifestSha256 === right.packageManifestSha256 &&
  left.platformPackageManifestSha256 === right.platformPackageManifestSha256 &&
  left.signerClassification === right.signerClassification &&
  left.packageVersion === right.packageVersion &&
  left.fixedPrefixArgs.length === right.fixedPrefixArgs.length &&
  left.fixedPrefixArgs.every((argument, index) => argument === right.fixedPrefixArgs[index]);

export const createBinding = <Id extends CliProviderId>(
  capture: CandidateCapture & Readonly<{ providerId: Id }>,
  versionValue: string,
  checkedAt: string,
): CliRuntimeBinding<Id, CliCredentialScopeFor<Id>> => {
  assertCaptureShape(capture);
  if (!isVersionSupported(capture.providerId, versionValue)) throw unsafeVersion();
  let version: SafeSemVer;
  try {
    version = parseSafeSemVer(versionValue);
  } catch {
    throw unsafeVersion();
  }
  if (new Date(checkedAt).toISOString() !== checkedAt) throw unsafeVersion();
  const recipe = SUPPORTED_CLI_RECIPES[capture.providerId];
  const identity = Object.freeze({
    providerId: capture.providerId,
    version,
    recipeId: recipe.recipeId,
    credentialScope: recipe.credentialScope,
    signerClassification: capture.signerClassification,
    launcherSha256: capture.launcherSha256,
    entrySha256: capture.entrySha256,
    packageManifestSha256: capture.packageManifestSha256,
    platformPackageManifestSha256: capture.platformPackageManifestSha256,
  });
  return Object.freeze({
    providerId: capture.providerId,
    canonicalLauncherPath: capture.canonicalLauncherPath,
    canonicalEntryPath: capture.canonicalEntryPath,
    canonicalPackageManifestPath: capture.canonicalPackageManifestPath,
    canonicalPlatformPackageManifestPath: capture.canonicalPlatformPackageManifestPath,
    fixedPrefixArgs: Object.freeze([...capture.fixedPrefixArgs]),
    version,
    launcherSha256: capture.launcherSha256,
    entrySha256: capture.entrySha256,
    packageManifestSha256: capture.packageManifestSha256,
    platformPackageManifestSha256: capture.platformPackageManifestSha256,
    bindingSha256: bindingHash(identity),
    recipeId: recipe.recipeId,
    credentialScope: recipe.credentialScope,
    signerClassification: capture.signerClassification,
    checkedAt,
  }) as CliRuntimeBinding<Id, CliCredentialScopeFor<Id>>;
};

export const assertBindingShape = (binding: CliRuntimeBinding): CandidateKind => {
  const entryPresent = binding.canonicalEntryPath !== null;
  const manifestPresent = binding.canonicalPackageManifestPath !== null;
  const platformPresent = binding.canonicalPlatformPackageManifestPath !== null;
  const kind: CandidateKind =
    binding.providerId === 'antigravity_cli'
      ? 'antigravity_native'
      : binding.providerId === 'gemini_cli'
        ? 'gemini_npm'
        : entryPresent
          ? 'codex_npm'
          : 'codex_native';
  const capture = Object.freeze({
    providerId: binding.providerId,
    kind,
    canonicalLauncherPath: binding.canonicalLauncherPath,
    canonicalEntryPath: binding.canonicalEntryPath,
    canonicalPackageManifestPath: binding.canonicalPackageManifestPath,
    canonicalPlatformPackageManifestPath: binding.canonicalPlatformPackageManifestPath,
    fixedPrefixArgs: binding.fixedPrefixArgs,
    launcherSha256: binding.launcherSha256,
    entrySha256: binding.entrySha256,
    packageManifestSha256: binding.packageManifestSha256,
    platformPackageManifestSha256: binding.platformPackageManifestSha256,
    signerClassification: binding.signerClassification,
    packageVersion: kind === 'gemini_npm' || kind === 'codex_npm' ? binding.version : null,
  });
  if (
    !entryPresent !== !manifestPresent ||
    binding.recipeId !== TRUSTED_CLI_BINDING_RECIPES[binding.providerId].recipeId ||
    binding.credentialScope !== SUPPORTED_CLI_RECIPES[binding.providerId].credentialScope ||
    !isVersionSupported(binding.providerId, binding.version) ||
    binding.bindingSha256 !==
      bindingHash({
        providerId: binding.providerId,
        version: binding.version,
        recipeId: binding.recipeId,
        credentialScope: binding.credentialScope,
        signerClassification: binding.signerClassification,
        launcherSha256: binding.launcherSha256,
        entrySha256: binding.entrySha256,
        packageManifestSha256: binding.packageManifestSha256,
        platformPackageManifestSha256: binding.platformPackageManifestSha256,
      }) ||
    (platformPresent && kind !== 'codex_npm')
  ) {
    throw unsafeVersion();
  }
  assertCaptureShape(capture);
  return kind;
};

export const captureMatchesBinding = (
  capture: CandidateCapture,
  binding: CliRuntimeBinding,
): boolean => {
  const current = createBinding(capture, binding.version, binding.checkedAt);
  const npmPackageVersionMatches =
    capture.kind === 'gemini_npm' || capture.kind === 'codex_npm'
      ? capture.packageVersion !== null && capture.packageVersion === binding.version
      : capture.packageVersion === null;
  const keys = [
    'providerId',
    'canonicalLauncherPath',
    'canonicalEntryPath',
    'canonicalPackageManifestPath',
    'canonicalPlatformPackageManifestPath',
    'version',
    'launcherSha256',
    'entrySha256',
    'packageManifestSha256',
    'platformPackageManifestSha256',
    'bindingSha256',
    'recipeId',
    'credentialScope',
    'signerClassification',
  ] as const;
  return (
    npmPackageVersionMatches &&
    keys.every((key) => current[key] === binding[key]) &&
    current.fixedPrefixArgs.length === binding.fixedPrefixArgs.length &&
    current.fixedPrefixArgs.every((argument, index) => argument === binding.fixedPrefixArgs[index])
  );
};
