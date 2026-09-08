import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { win32 } from 'node:path';
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
} from '../../../../../src/infrastructure/providers/cli/cliFileIntegrity';
import {
  createWindowsCredentialPresence,
  WINDOWS_CREDENTIAL_PRESENCE_ENCODED_COMMAND,
} from '../../../../../src/infrastructure/providers/cli/windowsCredentialPresence';
import { WINDOWS_POWERSHELL_PATH } from '../../../../../src/infrastructure/providers/cli/windowsPowerShell';

class FakeProcessRunner implements CliProcessRunner {
  readonly requests: CliProcessRequest[] = [];
  readonly results: Array<CliProcessResult | Error> = [];
  onRun: (() => void) | null = null;

  queue(result: CliProcessResult | Error): void {
    this.results.push(result instanceof Error ? result : Object.freeze({ ...result }));
  }

  async run(request: CliProcessRequest): Promise<CliProcessResult> {
    this.requests.push(request);
    this.onRun?.();
    const result = this.results.shift();
    if (result === undefined) throw new Error('NO_PROCESS_RESULT');
    if (result instanceof Error) throw result;
    return result;
  }

  cancel(): void {}
}

class FakeFiles implements CliExecutableFileAccess {
  canonical: string = WINDOWS_POWERSHELL_PATH;
  reparseRejected = false;
  readonly canonicalizedPaths: string[] = [];
  readonly checkedPaths: string[] = [];

  async canonicalize(path: string): Promise<string> {
    this.canonicalizedPaths.push(path);
    return this.canonical;
  }

  async assertNoReparsePoints(path: string): Promise<void> {
    this.checkedPaths.push(path);
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
  readonly paths: string[] = [];

  async sha256(path: string): Promise<string> {
    this.paths.push(path);
    const hash = this.hashes.shift();
    if (hash === undefined) throw new Error('NO_HASH');
    return hash;
  }
}

const connectionOperation = (controller = new AbortController()): ProviderConnectionOperation =>
  Object.freeze({ requestId: randomUUID(), signal: controller.signal });

const presenceFor = (
  runner: FakeProcessRunner,
  files = new FakeFiles(),
  hasher = new FakeHasher(),
) => createWindowsCredentialPresence({ runner, files, hasher });

describe('Windows Gemini OAuth credential presence', () => {
  it.each([
    ['present', '{"status":"present"}'],
    ['absent', '{"status":"absent"}'],
  ] as const)('returns only canonical %s metadata', async (expected, stdout) => {
    const runner = new FakeProcessRunner();
    runner.queue({ exitCode: 0, stdout, stderr: '' });

    await expect(presenceFor(runner).inspectGeminiOauth(connectionOperation())).resolves.toBe(
      expected,
    );
  });

  it('uses one fixed bounded PowerShell request with no target parameter', async () => {
    const runner = new FakeProcessRunner();
    const operation = connectionOperation();
    runner.queue({ exitCode: 0, stdout: '{"status":"present"}', stderr: '' });

    await presenceFor(runner).inspectGeminiOauth(operation);

    expect(runner.requests).toHaveLength(1);
    const request = runner.requests[0];
    expect(request).toMatchObject({
      requestId: operation.requestId,
      launcherPath: WINDOWS_POWERSHELL_PATH,
      cwd: win32.dirname(WINDOWS_POWERSHELL_PATH),
      env: {},
      stdin: '',
      timeoutMs: 10_000,
      stdoutLimitBytes: 256,
      stderrLimitBytes: 256,
      signal: operation.signal,
      shell: false,
    });
    expect(request?.args).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      WINDOWS_CREDENTIAL_PRESENCE_ENCODED_COMMAND,
    ]);
  });

  it('pins a field-blind CredReadW script to the exact Gemini target', () => {
    const script = Buffer.from(WINDOWS_CREDENTIAL_PRESENCE_ENCODED_COMMAND, 'base64').toString(
      'utf16le',
    );

    expect(createHash('sha256').update(script, 'utf8').digest('hex')).toBe(
      'bacf83ac2c43f27eb6353680b484af589312a85b49b79fb62bb8743fcb3cfeb2',
    );
    expect(script.match(/gemini-cli-oauth\/main-account/gu)).toHaveLength(1);
    expect(script).toContain('private const uint CRED_TYPE_GENERIC = 1;');
    expect(script).toContain('private const int ERROR_NOT_FOUND = 1168;');
    expect(script).toContain('EntryPoint = "CredReadW"');
    expect(script).toContain(
      'CredReadW("gemini-cli-oauth/main-account", CRED_TYPE_GENERIC, 0, out credential)',
    );
    expect(script).toContain(
      `if (CredReadW("gemini-cli-oauth/main-account", CRED_TYPE_GENERIC, 0, out credential))
        {
            if (credential == IntPtr.Zero)
            {
                return 2;
            }

            CredFree(credential);
            return 1;`,
    );
    expect(script).toContain('int error = Marshal.GetLastWin32Error();');
    expect(script).toContain('return error == ERROR_NOT_FOUND ? 0 : 2;');
    expect(script).not.toMatch(
      /CredEnumerate|CredWrite|CredDelete|CredentialBlob|PtrToStructure|StructureToPtr|Marshal\.Copy|Marshal\.Read|struct\s+CREDENTIAL|\.TargetName|\.UserName/iu,
    );
    expect(script).not.toMatch(/GetEnvironmentVariable|\$env:|param\s*\(/iu);
  });

  it.each([
    {
      name: 'trailing whitespace',
      result: { exitCode: 0, stdout: '{"status":"present"}\n', stderr: '' },
    },
    {
      name: 'leading whitespace',
      result: { exitCode: 0, stdout: ' {"status":"absent"}', stderr: '' },
    },
    {
      name: 'additional output',
      result: { exitCode: 0, stdout: '{"status":"present","detail":"private"}', stderr: '' },
    },
    {
      name: 'unknown status',
      result: { exitCode: 0, stdout: '{"status":"error"}', stderr: '' },
    },
    {
      name: 'stderr output',
      result: { exitCode: 0, stdout: '{"status":"present"}', stderr: 'private stderr' },
    },
    {
      name: 'Win32 failure',
      result: { exitCode: 1, stdout: '', stderr: 'Win32 code 5 at private target' },
    },
    {
      name: 'process exception',
      result: new Error('private runner failure'),
    },
  ])('fails closed for $name without reflecting process details', async ({ result }) => {
    const runner = new FakeProcessRunner();
    runner.queue(result);

    const pending = presenceFor(runner).inspectGeminiOauth(connectionOperation());
    await expect(pending).rejects.toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
    await expect(pending).rejects.not.toThrow(
      /private|stderr|Win32 code 5|runner failure|gemini-cli-oauth/iu,
    );
  });

  it('verifies the fixed helper before and after a successful inspection', async () => {
    const runner = new FakeProcessRunner();
    const files = new FakeFiles();
    const hasher = new FakeHasher();
    runner.queue({ exitCode: 0, stdout: '{"status":"absent"}', stderr: '' });

    await presenceFor(runner, files, hasher).inspectGeminiOauth(connectionOperation());

    expect(files.canonicalizedPaths).toEqual([WINDOWS_POWERSHELL_PATH, WINDOWS_POWERSHELL_PATH]);
    expect(files.checkedPaths).toEqual([
      WINDOWS_POWERSHELL_PATH,
      WINDOWS_POWERSHELL_PATH,
      WINDOWS_POWERSHELL_PATH,
      WINDOWS_POWERSHELL_PATH,
    ]);
    expect(hasher.paths).toEqual([WINDOWS_POWERSHELL_PATH, WINDOWS_POWERSHELL_PATH]);
  });

  it.each(['canonical path drift', 'reparse point', 'invalid helper hash'])(
    'rejects fixed PowerShell %s before process execution',
    async (failure) => {
      const runner = new FakeProcessRunner();
      const files = new FakeFiles();
      const hasher = new FakeHasher();
      if (failure === 'canonical path drift') {
        files.canonical =
          'C:\\Attacker\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
      } else if (failure === 'reparse point') {
        files.reparseRejected = true;
      } else {
        hasher.hashes = ['invalid'];
      }

      await expect(
        presenceFor(runner, files, hasher).inspectGeminiOauth(connectionOperation()),
      ).rejects.toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
      expect(runner.requests).toHaveLength(0);
    },
  );

  it('rejects helper hash drift after process execution', async () => {
    const runner = new FakeProcessRunner();
    const hasher = new FakeHasher();
    hasher.hashes = ['a'.repeat(64), 'b'.repeat(64)];
    runner.queue({ exitCode: 0, stdout: '{"status":"present"}', stderr: '' });

    await expect(
      presenceFor(runner, new FakeFiles(), hasher).inspectGeminiOauth(connectionOperation()),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
    expect(runner.requests).toHaveLength(1);
  });

  it('rejects a pre-aborted operation before helper or process access', async () => {
    const runner = new FakeProcessRunner();
    const files = new FakeFiles();
    const hasher = new FakeHasher();
    const controller = new AbortController();
    controller.abort();

    await expect(
      presenceFor(runner, files, hasher).inspectGeminiOauth(connectionOperation(controller)),
    ).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    expect(runner.requests).toHaveLength(0);
    expect(files.checkedPaths).toHaveLength(0);
    expect(hasher.paths).toHaveLength(0);
  });

  it('preserves cancellation raised during helper execution', async () => {
    const runner = new FakeProcessRunner();
    const controller = new AbortController();
    const operation = connectionOperation(controller);
    runner.queue({ exitCode: 0, stdout: '{"status":"present"}', stderr: '' });
    runner.onRun = () => controller.abort();

    await expect(presenceFor(runner).inspectGeminiOauth(operation)).rejects.toMatchObject({
      code: 'PROVIDER_CANCELLED',
    });
    expect(runner.requests).toHaveLength(1);
    expect(runner.requests[0]?.signal).toBe(operation.signal);
  });

  it('rejects constructor extensions before side effects', () => {
    const runner = new FakeProcessRunner();
    const files = new FakeFiles();
    const hasher = new FakeHasher();

    expect(() =>
      createWindowsCredentialPresence({
        runner,
        files,
        hasher,
        target: 'attacker-controlled-target',
      } as never),
    ).toThrow();
    expect(runner.requests).toHaveLength(0);
    expect(files.checkedPaths).toHaveLength(0);
  });
});
