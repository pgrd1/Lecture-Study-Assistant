import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ProviderConnectionOperation } from '../../../../../src/core/ports/aiProvider';
import type {
  CliProcessRequest,
  CliProcessResult,
  CliProcessRunner,
} from '../../../../../src/core/ports/cliProcessRunner';
import type {
  CliExecutableFileAccess,
  CliFileHasher,
} from '../../../../../src/infrastructure/providers/cli/cliExecutableInspector';
import {
  createWindowsKnownFolderProviderForTest,
  WINDOWS_KNOWN_FOLDERS_ENCODED_COMMAND,
} from '../../../../../src/infrastructure/providers/cli/windowsKnownFolders';
import { WINDOWS_POWERSHELL_PATH } from '../../../../../src/infrastructure/providers/cli/windowsPowerShell';

const VALID_OUTPUT = JSON.stringify({
  appData: 'C:\\Users\\student\\AppData\\Roaming',
  localAppData: 'C:\\Users\\student\\AppData\\Local',
  programFiles: 'C:\\Program Files',
  architecture: 'x64',
});

class FakeFiles implements CliExecutableFileAccess {
  canonical: string = WINDOWS_POWERSHELL_PATH;
  reparseRejected = false;
  readonly reparseChecks: string[] = [];

  async canonicalize(): Promise<string> {
    return this.canonical;
  }

  async assertNoReparsePoints(path: string): Promise<void> {
    this.reparseChecks.push(path);
    if (this.reparseRejected) throw new Error('REPARSE_POINT');
  }

  async readFile(): Promise<Uint8Array> {
    throw new Error('NOT_USED');
  }

  async listChildren(): Promise<readonly string[]> {
    return Object.freeze([]);
  }
}

class FakeHasher implements CliFileHasher {
  hashes = ['a'.repeat(64), 'a'.repeat(64)];
  readonly calls: string[] = [];

  async sha256(path: string): Promise<string> {
    this.calls.push(path);
    const hash = this.hashes.shift();
    if (hash === undefined) throw new Error('NO_HASH');
    return hash;
  }
}

class FakeRunner implements CliProcessRunner {
  readonly requests: CliProcessRequest[] = [];
  result: CliProcessResult = Object.freeze({ exitCode: 0, stdout: VALID_OUTPUT, stderr: '' });
  onRun: (() => void) | null = null;

  async run(request: CliProcessRequest): Promise<CliProcessResult> {
    this.requests.push(request);
    this.onRun?.();
    return this.result;
  }

  cancel(): void {}
}

const harness = () => {
  const files = new FakeFiles();
  const hasher = new FakeHasher();
  const runner = new FakeRunner();
  const controller = new AbortController();
  const operation: ProviderConnectionOperation = Object.freeze({
    requestId: randomUUID(),
    signal: controller.signal,
  });
  return {
    controller,
    files,
    hasher,
    operation,
    runner,
    provider: createWindowsKnownFolderProviderForTest({ files, hasher, runner }),
  };
};

describe('Windows Known Folder provider', () => {
  it('uses only fixed verified PowerShell and returns a frozen main-only roots snapshot', async () => {
    const setup = harness();

    const roots = await setup.provider.load(setup.operation);

    expect(roots).toEqual({
      appData: 'C:\\Users\\student\\AppData\\Roaming',
      localAppData: 'C:\\Users\\student\\AppData\\Local',
      programFiles: 'C:\\Program Files',
      architecture: 'x64',
    });
    expect(Object.isFrozen(roots)).toBe(true);
    expect(setup.runner.requests).toHaveLength(1);
    expect(setup.runner.requests[0]).toMatchObject({
      launcherPath: WINDOWS_POWERSHELL_PATH,
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        WINDOWS_KNOWN_FOLDERS_ENCODED_COMMAND,
      ],
      cwd: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
      env: {},
      stdin: '',
      requestId: setup.operation.requestId,
      signal: setup.operation.signal,
      shell: false,
    });
    expect(
      Buffer.from(WINDOWS_KNOWN_FOLDERS_ENCODED_COMMAND, 'base64').toString('utf16le'),
    ).not.toMatch(/env:|process\.env|USERPROFILE|HOME/u);
    expect(setup.files.reparseChecks).toEqual([
      WINDOWS_POWERSHELL_PATH,
      WINDOWS_POWERSHELL_PATH,
      WINDOWS_POWERSHELL_PATH,
      WINDOWS_POWERSHELL_PATH,
    ]);
    expect(setup.hasher.calls).toEqual([WINDOWS_POWERSHELL_PATH, WINDOWS_POWERSHELL_PATH]);
  });

  it.each([
    ['extra system root', { ...JSON.parse(VALID_OUTPUT), systemRoot: 'C:\\Attacker\\Windows' }],
    ['UNC local app data', { ...JSON.parse(VALID_OUTPUT), localAppData: '\\\\server\\share' }],
    [
      'redirected roaming data',
      { ...JSON.parse(VALID_OUTPUT), appData: 'D:\\Redirected\\Roaming' },
    ],
    ['control character', { ...JSON.parse(VALID_OUTPUT), programFiles: 'C:\\Program\u0000Files' }],
    ['unsupported architecture', { ...JSON.parse(VALID_OUTPUT), architecture: 'ia32' }],
  ])('rejects strict Known Folder output with %s', async (_name, output) => {
    const setup = harness();
    setup.runner.result = Object.freeze({
      exitCode: 0,
      stdout: JSON.stringify(output),
      stderr: '',
    });

    await expect(setup.provider.load(setup.operation)).rejects.toMatchObject({
      code: 'PROVIDER_UNSAFE_VERSION',
    });
  });

  it.each(['canonical path drift', 'reparse point', 'invalid helper hash'])(
    'rejects %s before starting PowerShell',
    async (failure) => {
      const setup = harness();
      if (failure === 'canonical path drift') {
        setup.files.canonical =
          'C:\\Attacker\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
      } else if (failure === 'reparse point') {
        setup.files.reparseRejected = true;
      } else {
        setup.hasher.hashes = ['not-a-sha256'];
      }

      await expect(setup.provider.load(setup.operation)).rejects.toMatchObject({
        code: 'PROVIDER_UNSAFE_VERSION',
      });
      expect(setup.runner.requests).toHaveLength(0);
    },
  );

  it('rejects a helper hash change after invocation before parsing its output', async () => {
    const setup = harness();
    setup.hasher.hashes = ['a'.repeat(64), 'b'.repeat(64)];
    setup.runner.result = Object.freeze({
      exitCode: 0,
      stdout: JSON.stringify({ ...JSON.parse(VALID_OUTPUT), private: 'C:\\private' }),
      stderr: 'private detail',
    });

    const pending = setup.provider.load(setup.operation);
    await expect(pending).rejects.toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
    await expect(pending).rejects.not.toThrow(/private detail|C:\\private/u);
  });

  it('rejects a pre-aborted operation before file or process access', async () => {
    const setup = harness();
    setup.controller.abort();

    await expect(setup.provider.load(setup.operation)).rejects.toMatchObject({
      code: 'PROVIDER_CANCELLED',
    });
    expect(setup.files.reparseChecks).toHaveLength(0);
    expect(setup.hasher.calls).toHaveLength(0);
    expect(setup.runner.requests).toHaveLength(0);
  });

  it('propagates the same operation signal and cancels before parsing an in-flight result', async () => {
    const setup = harness();
    setup.runner.result = Object.freeze({
      exitCode: 0,
      stdout: JSON.stringify({ ...JSON.parse(VALID_OUTPUT), private: 'C:\\private' }),
      stderr: 'private detail',
    });
    setup.runner.onRun = () => setup.controller.abort();

    const pending = setup.provider.load(setup.operation);

    await expect(pending).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    await expect(pending).rejects.not.toThrow(/private detail|C:\\private/u);
    expect(setup.runner.requests).toHaveLength(1);
    expect(setup.runner.requests[0]?.requestId).toBe(setup.operation.requestId);
    expect(setup.runner.requests[0]?.signal).toBe(setup.operation.signal);
  });
});
