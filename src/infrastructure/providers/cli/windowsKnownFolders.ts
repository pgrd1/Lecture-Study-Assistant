import { Buffer } from 'node:buffer';
import { win32 } from 'node:path';
import type { ProviderConnectionOperation } from '../../../core/ports/aiProvider';
import type { CliProcessRunner } from '../../../core/ports/cliProcessRunner';
import type { CliExecutableFileAccess, CliFileHasher } from './cliFileIntegrity';
import {
  assertProviderConnectionActive,
  isCanonicalAbsoluteWindowsPath,
  sameWindowsPath,
  unsafeVersion,
} from './cliFileIntegrity';
import {
  runVerifiedWindowsPowerShell,
  type WindowsPowerShellDependencies,
} from './windowsPowerShell';

const WINDOWS_KNOWN_FOLDERS_SCRIPT = `$ErrorActionPreference = 'Stop'
$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
[pscustomobject]@{
  appData = [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)
  localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
  programFiles = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
  architecture = $architecture.ToLowerInvariant()
} | ConvertTo-Json -Compress`;

export const WINDOWS_KNOWN_FOLDERS_ENCODED_COMMAND = Buffer.from(
  WINDOWS_KNOWN_FOLDERS_SCRIPT,
  'utf16le',
).toString('base64');

declare const WINDOWS_KNOWN_FOLDERS_BRAND: unique symbol;

export type WindowsKnownFolders = Readonly<{
  appData: string;
  localAppData: string;
  programFiles: string;
  architecture: 'x64' | 'arm64';
  readonly [WINDOWS_KNOWN_FOLDERS_BRAND]: true;
}>;

export interface WindowsKnownFolderProvider {
  load(operation: ProviderConnectionOperation): Promise<WindowsKnownFolders>;
}

type KnownFolderProviderOptions = Readonly<{
  runner: CliProcessRunner;
  files: CliExecutableFileAccess;
  hasher: CliFileHasher;
}>;

type RawKnownFolders = Readonly<{
  appData: string;
  localAppData: string;
  programFiles: string;
  architecture: 'x64' | 'arm64';
}>;

const issuedKnownFolderSnapshots = new WeakSet<object>();

const parseKnownFolderObject = (value: unknown): WindowsKnownFolders => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw unsafeVersion();
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  if (
    keys.length !== 4 ||
    keys[0] !== 'appData' ||
    keys[1] !== 'architecture' ||
    keys[2] !== 'localAppData' ||
    keys[3] !== 'programFiles' ||
    typeof object.appData !== 'string' ||
    typeof object.localAppData !== 'string' ||
    typeof object.programFiles !== 'string' ||
    (object.architecture !== 'x64' && object.architecture !== 'arm64')
  ) {
    throw unsafeVersion();
  }
  const appData = object.appData;
  const localAppData = object.localAppData;
  const programFiles = object.programFiles;
  const appDataParent = win32.dirname(appData);
  const localAppDataParent = win32.dirname(localAppData);
  const userRoot = win32.dirname(appDataParent);
  if (
    ![appData, localAppData, programFiles].every(
      (path) =>
        isCanonicalAbsoluteWindowsPath(path) &&
        win32.parse(path).root.toLowerCase() !== path.toLowerCase(),
    ) ||
    win32.basename(appData).toLowerCase() !== 'roaming' ||
    win32.basename(localAppData).toLowerCase() !== 'local' ||
    !sameWindowsPath(appDataParent, localAppDataParent) ||
    win32.basename(appDataParent).toLowerCase() !== 'appdata' ||
    !sameWindowsPath(win32.dirname(userRoot), 'C:\\Users') ||
    !sameWindowsPath(programFiles, 'C:\\Program Files')
  ) {
    throw unsafeVersion();
  }
  const snapshot = Object.freeze({
    appData,
    localAppData,
    programFiles,
    architecture: object.architecture,
  }) as WindowsKnownFolders;
  issuedKnownFolderSnapshots.add(snapshot);
  return snapshot;
};

export const isIssuedWindowsKnownFolders = (value: WindowsKnownFolders): boolean =>
  issuedKnownFolderSnapshots.has(value);

const parseKnownFolderOutput = (output: string): WindowsKnownFolders => {
  if (output.length === 0 || Buffer.byteLength(output, 'utf8') > 4_096) throw unsafeVersion();
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw unsafeVersion();
  }
  return parseKnownFolderObject(parsed);
};

class FixedWindowsKnownFolderProvider implements WindowsKnownFolderProvider {
  readonly #dependencies: WindowsPowerShellDependencies;

  constructor(options: KnownFolderProviderOptions) {
    this.#dependencies = Object.freeze({ ...options });
  }

  async load(operation: ProviderConnectionOperation): Promise<WindowsKnownFolders> {
    assertProviderConnectionActive(operation);
    const result = await runVerifiedWindowsPowerShell(
      this.#dependencies,
      {
        encodedCommand: WINDOWS_KNOWN_FOLDERS_ENCODED_COMMAND,
        env: Object.freeze({}),
        timeoutMs: 10_000,
        stdoutLimitBytes: 4_096,
        stderrLimitBytes: 1_024,
      },
      operation,
    );
    assertProviderConnectionActive(operation);
    if (result.exitCode !== 0) throw unsafeVersion();
    return parseKnownFolderOutput(result.stdout);
  }
}

export const createWindowsKnownFolderProvider = (
  options: KnownFolderProviderOptions,
): WindowsKnownFolderProvider => new FixedWindowsKnownFolderProvider(options);

export const createWindowsKnownFolderProviderForTest = createWindowsKnownFolderProvider;

export const createWindowsKnownFoldersForTest = (value: RawKnownFolders): WindowsKnownFolders =>
  parseKnownFolderObject(value);
