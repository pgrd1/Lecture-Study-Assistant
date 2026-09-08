import { describe, expect, it } from 'vitest';
import type { ProviderConnectionOperation } from '../../../../../src/core/ports/aiProvider';
import type {
  CliProcessRequest,
  CliProcessRunner,
} from '../../../../../src/core/ports/cliProcessRunner';
import {
  createWindowsSubstMappingPortForTest,
  createWindowsToolIdentityGuardForTest,
  WINDOWS_SUBST_PATH,
  type WindowsToolIdentityGuard,
} from '../../../../../src/infrastructure/providers/cli/windowsSubstMapping';

const runtimeRoot = 'C:\\Users\\student\\AppData\\Local\\StudyApp\\providers';
const operation = Object.freeze({
  requestId: '40000000-0000-4000-8000-000000000001',
  signal: new AbortController().signal,
}) satisfies ProviderConnectionOperation;

describe('Windows subst mapping', () => {
  it('pins the canonical tool hash and revalidates it after every operation', async () => {
    const hash = { value: 'a'.repeat(64) };
    const canonicalizeCalls: string[] = [];
    const reparseChecks: string[] = [];
    const fileOperations: ProviderConnectionOperation[] = [];
    const hashOperations: ProviderConnectionOperation[] = [];
    let unsafeRunInvoked = false;
    const tools = createWindowsToolIdentityGuardForTest({
      files: {
        canonicalize: async (path, requestedOperation) => {
          canonicalizeCalls.push(path);
          fileOperations.push(requestedOperation);
          return path;
        },
        assertNoReparsePoints: async (path, requestedOperation) => {
          reparseChecks.push(path);
          fileOperations.push(requestedOperation);
        },
        readFile: async () => new Uint8Array(),
        listChildren: async () => [],
      },
      hasher: {
        sha256: async (_path, requestedOperation) => {
          hashOperations.push(requestedOperation);
          return hash.value;
        },
      },
    });

    await expect(tools.runVerified(WINDOWS_SUBST_PATH, operation, async () => 'ok')).resolves.toBe(
      'ok',
    );
    await expect(
      tools.runVerified(WINDOWS_SUBST_PATH, operation, async () => {
        unsafeRunInvoked = true;
        hash.value = 'b'.repeat(64);
        return 'must-not-escape';
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
    await expect(
      tools.runVerified('C:\\Attacker\\subst.exe', operation, async () => 'must-not-run'),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });

    expect(unsafeRunInvoked).toBe(true);
    expect(canonicalizeCalls).toContain(WINDOWS_SUBST_PATH);
    expect(reparseChecks).toContain(WINDOWS_SUBST_PATH);
    expect(fileOperations.length).toBeGreaterThan(0);
    expect(fileOperations.every((value) => value === operation)).toBe(true);
    expect(hashOperations).toEqual([operation, operation, operation, operation]);
  });

  it('uses fixed shell-free argv and forwards the caller operation unchanged', async () => {
    const requests: CliProcessRequest[] = [];
    const results = [
      '',
      '',
      'R:\\: => C:\\Users\\student\\AppData\\Local\\StudyApp\\providers\r\n',
      'R:\\: => C:\\Users\\student\\AppData\\Local\\StudyApp\\providers\r\n',
      '',
      '',
    ];
    const runner: CliProcessRunner = {
      run: async (request) => {
        requests.push(request);
        return { exitCode: 0, stdout: results.shift() ?? '', stderr: '' };
      },
      cancel: () => {},
    };
    const toolPaths: string[] = [];
    const toolOperations: ProviderConnectionOperation[] = [];
    const tools: WindowsToolIdentityGuard = {
      runVerified: async (path, requestedOperation, run) => {
        toolPaths.push(path);
        toolOperations.push(requestedOperation);
        return run();
      },
    };
    const port = createWindowsSubstMappingPortForTest({ runner, tools });

    await port.map('R:', runtimeRoot, operation);
    await port.unmap('R:', runtimeRoot, operation);

    expect(
      requests.map(({ launcherPath, args, shell }) => ({ launcherPath, args, shell })),
    ).toEqual([
      { launcherPath: WINDOWS_SUBST_PATH, args: [], shell: false },
      { launcherPath: WINDOWS_SUBST_PATH, args: ['R:', runtimeRoot], shell: false },
      { launcherPath: WINDOWS_SUBST_PATH, args: [], shell: false },
      { launcherPath: WINDOWS_SUBST_PATH, args: [], shell: false },
      { launcherPath: WINDOWS_SUBST_PATH, args: ['R:', '/D'], shell: false },
      { launcherPath: WINDOWS_SUBST_PATH, args: [], shell: false },
    ]);
    expect(
      requests.every(
        (request) =>
          request.requestId === operation.requestId && request.signal === operation.signal,
      ),
    ).toBe(true);
    expect(toolPaths).toEqual(Array(6).fill(WINDOWS_SUBST_PATH));
    expect(toolOperations).toEqual(Array(6).fill(operation));
  });

  it('rejects a target that becomes canonical only after path normalization', async () => {
    const runner: CliProcessRunner = {
      run: async () => ({
        exitCode: 0,
        stdout: 'R:\\: => C:\\safe\\..\\foreign\r\n',
        stderr: '',
      }),
      cancel: () => {},
    };
    const port = createWindowsSubstMappingPortForTest({
      runner,
      tools: { runVerified: async (_path, _operation, run) => run() },
    });

    await expect(port.list(operation)).rejects.toMatchObject({
      code: 'PROVIDER_RESIDUAL_DATA',
    });
  });

  it('rejects subst output beyond the fixed UTF-8 byte bound', async () => {
    const runner: CliProcessRunner = {
      run: async () => ({ exitCode: 0, stdout: '아'.repeat(10_923), stderr: '' }),
      cancel: () => {},
    };
    const port = createWindowsSubstMappingPortForTest({
      runner,
      tools: { runVerified: async (_path, _operation, run) => run() },
    });

    await expect(port.list(operation)).rejects.toMatchObject({
      code: 'PROVIDER_RESIDUAL_DATA',
    });
  });

  it('never deletes a drive whose mapping changed before unmap', async () => {
    const requests: CliProcessRequest[] = [];
    const runner: CliProcessRunner = {
      run: async (request) => {
        requests.push(request);
        return {
          exitCode: 0,
          stdout: 'R:\\: => C:\\foreign\r\n',
          stderr: '',
        };
      },
      cancel: () => {},
    };
    const port = createWindowsSubstMappingPortForTest({
      runner,
      tools: { runVerified: async (_path, _operation, run) => run() },
    });

    await expect(port.unmap('R:', runtimeRoot, operation)).rejects.toMatchObject({
      code: 'PROVIDER_RESIDUAL_DATA',
    });
    expect(requests.map((request) => request.args)).toEqual([[]]);
  });
});
