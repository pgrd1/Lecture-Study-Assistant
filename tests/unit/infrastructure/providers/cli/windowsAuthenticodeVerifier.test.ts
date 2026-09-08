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
  AUTHENTICODE_PUBLISHER_SUBJECTS,
  AUTHENTICODE_TARGET_ENVIRONMENT_KEY,
  createWindowsAuthenticodeVerifierForTest,
  WINDOWS_AUTHENTICODE_ENCODED_COMMAND,
} from '../../../../../src/infrastructure/providers/cli/windowsAuthenticodeVerifier';
import { WINDOWS_POWERSHELL_PATH } from '../../../../../src/infrastructure/providers/cli/windowsPowerShell';

class FakeProcessRunner implements CliProcessRunner {
  readonly requests: CliProcessRequest[] = [];
  readonly results: CliProcessResult[] = [];
  onRun: (() => void) | null = null;

  queue(result: CliProcessResult): void {
    this.results.push(Object.freeze({ ...result }));
  }

  async run(request: CliProcessRequest): Promise<CliProcessResult> {
    this.requests.push(request);
    this.onRun?.();
    const result = this.results.shift();
    if (result === undefined) {
      throw new Error('NO_PROCESS_RESULT');
    }
    return result;
  }

  cancel(): void {}
}

class FakeFiles implements CliExecutableFileAccess {
  canonical: string = WINDOWS_POWERSHELL_PATH;
  reparseRejected = false;

  async canonicalize(path: string): Promise<string> {
    return path === WINDOWS_POWERSHELL_PATH ? this.canonical : path;
  }

  async assertNoReparsePoints(): Promise<void> {
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

  async sha256(): Promise<string> {
    const hash = this.hashes.shift();
    if (hash === undefined) throw new Error('NO_HASH');
    return hash;
  }
}

const verifierFor = (
  runner: FakeProcessRunner,
  files = new FakeFiles(),
  hasher = new FakeHasher(),
) => createWindowsAuthenticodeVerifierForTest({ runner, files, hasher });

const validOutput = (subject: string): string =>
  JSON.stringify({ status: 'Valid', subject, thumbprint: 'A'.repeat(40) });

const publisherSubject = (classification: 'google' | 'openai' | 'nodejs'): string => {
  const subject = AUTHENTICODE_PUBLISHER_SUBJECTS[classification][0];
  if (subject === undefined) throw new Error('MISSING_TEST_PUBLISHER');
  return subject;
};

const connectionOperation = (controller = new AbortController()): ProviderConnectionOperation =>
  Object.freeze({ requestId: randomUUID(), signal: controller.signal });

describe('Windows Authenticode verifier', () => {
  it('rejects an injected basename-valid attacker SystemRoot before starting a process', () => {
    const runner = new FakeProcessRunner();
    const files = new FakeFiles();
    const hasher = new FakeHasher();

    expect(() =>
      createWindowsAuthenticodeVerifierForTest({
        runner,
        files,
        hasher,
        systemRoot: 'C:\\Attacker\\Windows',
      } as never),
    ).toThrow();
    expect(runner.requests).toHaveLength(0);
  });

  it('keeps a hostile target path out of fixed PowerShell argv and script text', async () => {
    const runner = new FakeProcessRunner();
    const target = "C:\\Program Files\\OpenAI\\codex'; Start-Process calc; '.exe";
    runner.queue({
      exitCode: 0,
      stdout: validOutput(publisherSubject('openai')),
      stderr: '',
    });
    const verifier = verifierFor(runner);
    const operation = connectionOperation();

    await expect(verifier.verify(target, 'openai', operation)).resolves.toEqual({
      signerClassification: 'openai',
      certificateThumbprint: 'A'.repeat(40),
    });

    expect(runner.requests).toHaveLength(1);
    const request = runner.requests[0];
    expect(request?.launcherPath).toBe(WINDOWS_POWERSHELL_PATH);
    expect(request?.args).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      WINDOWS_AUTHENTICODE_ENCODED_COMMAND,
    ]);
    expect(request?.args.join(' ')).not.toContain(target);
    expect(
      Buffer.from(WINDOWS_AUTHENTICODE_ENCODED_COMMAND, 'base64').toString('utf16le'),
    ).not.toContain(target);
    expect(request?.env).toEqual({ [AUTHENTICODE_TARGET_ENVIRONMENT_KEY]: target });
    expect(request?.requestId).toBe(operation.requestId);
    expect(request?.signal).toBe(operation.signal);
    expect(request?.shell).toBe(false);
    expect(request?.stdoutLimitBytes).toBeLessThanOrEqual(4_096);
    expect(request?.timeoutMs).toBeLessThanOrEqual(10_000);
  });

  it.each(['google', 'openai', 'nodejs'] as const)(
    'classifies only the fixed %s publisher allowlist',
    async (classification) => {
      const runner = new FakeProcessRunner();
      runner.queue({
        exitCode: 0,
        stdout: validOutput(publisherSubject(classification)),
        stderr: '',
      });

      await expect(
        verifierFor(runner).verify('C:\\trusted.exe', classification, connectionOperation()),
      ).resolves.toMatchObject({ signerClassification: classification });
    },
  );

  it.each([
    {
      name: 'non-valid status',
      result: {
        exitCode: 0,
        stdout: JSON.stringify({
          status: 'NotSigned',
          subject: publisherSubject('google'),
          thumbprint: 'A'.repeat(40),
        }),
        stderr: '',
      },
    },
    {
      name: 'unknown publisher',
      result: {
        exitCode: 0,
        stdout: validOutput('CN=Attacker, O=Attacker, C=US'),
        stderr: '',
      },
    },
    {
      name: 'malformed thumbprint',
      result: {
        exitCode: 0,
        stdout: JSON.stringify({
          status: 'Valid',
          subject: publisherSubject('google'),
          thumbprint: 'not-a-thumbprint',
        }),
        stderr: '',
      },
    },
    {
      name: 'path-bearing extra output field',
      result: {
        exitCode: 0,
        stdout: JSON.stringify({
          status: 'Valid',
          subject: publisherSubject('google'),
          thumbprint: 'A'.repeat(40),
          path: 'C:\\private\\agy.exe',
        }),
        stderr: '',
      },
    },
    { name: 'PowerShell failure', result: { exitCode: 1, stdout: '', stderr: 'private detail' } },
  ])('fails closed for $name without reflecting raw output', async ({ result }) => {
    const runner = new FakeProcessRunner();
    runner.queue(result);
    const verifier = verifierFor(runner);

    const pending = verifier.verify('C:\\private\\agy.exe', 'google', connectionOperation());
    await expect(pending).rejects.toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
    await expect(pending).rejects.not.toThrow(/private detail|C:\\private/u);
  });

  it.each(['canonical path drift', 'reparse point', 'invalid helper hash'])(
    'rejects fixed PowerShell %s before starting the helper',
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
        hasher.hashes = ['not-a-sha256'];
      }
      const verifier = verifierFor(runner, files, hasher);

      await expect(
        verifier.verify('C:\\trusted.exe', 'google', connectionOperation()),
      ).rejects.toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
      expect(runner.requests).toHaveLength(0);
    },
  );

  it('rejects PowerShell canonical or hash drift after invocation', async () => {
    const runner = new FakeProcessRunner();
    const files = new FakeFiles();
    const hasher = new FakeHasher();
    hasher.hashes = ['a'.repeat(64), 'b'.repeat(64)];
    runner.queue({
      exitCode: 0,
      stdout: validOutput(publisherSubject('openai')),
      stderr: '',
    });

    await expect(
      verifierFor(runner, files, hasher).verify('C:\\trusted.exe', 'openai', connectionOperation()),
    ).rejects.toMatchObject({
      code: 'PROVIDER_UNSAFE_VERSION',
    });
    expect(runner.requests).toHaveLength(1);
  });

  it('rejects a pre-aborted operation before file or process access', async () => {
    const runner = new FakeProcessRunner();
    const files = new FakeFiles();
    const hasher = new FakeHasher();
    const controller = new AbortController();
    const operation = connectionOperation(controller);
    controller.abort();

    await expect(
      verifierFor(runner, files, hasher).verify('C:\\trusted.exe', 'google', operation),
    ).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    expect(runner.requests).toHaveLength(0);
    expect(hasher.hashes).toHaveLength(2);
  });

  it('propagates the same operation and preserves cancellation during helper execution', async () => {
    const runner = new FakeProcessRunner();
    const controller = new AbortController();
    const operation = connectionOperation(controller);
    runner.queue({
      exitCode: 0,
      stdout: validOutput(publisherSubject('google')),
      stderr: '',
    });
    runner.onRun = () => controller.abort();

    await expect(
      verifierFor(runner).verify('C:\\trusted.exe', 'google', operation),
    ).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    expect(runner.requests).toHaveLength(1);
    expect(runner.requests[0]?.requestId).toBe(operation.requestId);
    expect(runner.requests[0]?.signal).toBe(operation.signal);
  });
});
