import { Buffer } from 'node:buffer';
import { spawn as nodeSpawn } from 'node:child_process';
import type {
  CliProcessRequest,
  CliProcessResult,
  CliProcessRunner,
} from '../../../core/ports/cliProcessRunner';
import { APP_ERROR_MESSAGES, AppError } from '../../../shared/errors';
import { isCanonicalAbsoluteWindowsPath } from './cliFileIntegrity';

export const MAX_CLI_STDIN_BYTES = 8 * 1024 * 1024;
const MAX_CLI_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_CLI_TIMEOUT_MS = 900_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const providerError = (
  code:
    | 'PROVIDER_CANCELLED'
    | 'PROVIDER_EXECUTION_FAILED'
    | 'PROVIDER_REQUEST_TOO_LARGE'
    | 'PROVIDER_RESPONSE_TOO_LARGE'
    | 'PROVIDER_TIMEOUT',
): AppError => new AppError(code, APP_ERROR_MESSAGES[code]);

export type CliSpawnOptions = Readonly<{
  shell: false;
  windowsHide: true;
  cwd: string;
  env: Readonly<Record<string, string>>;
  stdio: readonly ['pipe', 'pipe', 'pipe'];
}>;

type ByteListener = (chunk: Uint8Array | string) => void;
type CloseListener = (exitCode: number | null) => void;
type ErrorListener = (error: Error) => void;
type FinishListener = () => void;

export interface CliReadableStream {
  on(event: 'data', listener: ByteListener): this;
}

export interface CliWritableStream {
  end(data?: Uint8Array): void;
  once?(event: 'error', listener: ErrorListener): this;
  once?(event: 'finish', listener: FinishListener): this;
}

export interface CliChildProcess {
  readonly pid?: number;
  readonly stdout: CliReadableStream;
  readonly stderr: CliReadableStream;
  readonly stdin: CliWritableStream;
  readonly exitCode: number | null;
  once(event: 'close', listener: CloseListener): this;
  once(event: 'error', listener: ErrorListener): this;
  kill(): boolean;
}

export interface CliSpawnFacade {
  spawn(file: string, args: readonly string[], options: CliSpawnOptions): CliChildProcess;
}

export const createNodeSpawnFacade = (): CliSpawnFacade =>
  Object.freeze({
    spawn: (file: string, args: readonly string[], options: CliSpawnOptions) =>
      nodeSpawn(file, [...args], {
        shell: false,
        windowsHide: true,
        cwd: options.cwd,
        env: { ...options.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as unknown as CliChildProcess,
  });

type ProcessOutcome =
  | Readonly<{ kind: 'close'; exitCode: number }>
  | Readonly<{
      kind: 'failure';
      code:
        | 'PROVIDER_CANCELLED'
        | 'PROVIDER_EXECUTION_FAILED'
        | 'PROVIDER_RESPONSE_TOO_LARGE'
        | 'PROVIDER_TIMEOUT';
    }>;

type BoundedNodeProcessRunnerOptions = Readonly<{ spawner: CliSpawnFacade }>;

const isSafeText = (value: string): boolean => !value.includes('\0');

const validateRequest = (request: CliProcessRequest): void => {
  if (Buffer.byteLength(request.stdin, 'utf8') > MAX_CLI_STDIN_BYTES) {
    throw providerError('PROVIDER_REQUEST_TOO_LARGE');
  }
  if (
    !UUID_PATTERN.test(request.requestId) ||
    request.postProcessValidation !== undefined ||
    request.shell !== false ||
    !(request.signal instanceof AbortSignal) ||
    !isCanonicalAbsoluteWindowsPath(request.launcherPath) ||
    !isCanonicalAbsoluteWindowsPath(request.cwd) ||
    !request.args.every(isSafeText) ||
    !Object.entries(request.env).every(
      ([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) && isSafeText(value),
    ) ||
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs <= 0 ||
    request.timeoutMs > MAX_CLI_TIMEOUT_MS ||
    !Number.isSafeInteger(request.stdoutLimitBytes) ||
    request.stdoutLimitBytes <= 0 ||
    request.stdoutLimitBytes > MAX_CLI_OUTPUT_BYTES ||
    !Number.isSafeInteger(request.stderrLimitBytes) ||
    request.stderrLimitBytes <= 0 ||
    request.stderrLimitBytes > MAX_CLI_OUTPUT_BYTES
  ) {
    throw providerError('PROVIDER_EXECUTION_FAILED');
  }
};

class BoundedNodeProcessRunner implements CliProcessRunner {
  readonly #spawner: CliSpawnFacade;
  readonly #controllers = new Map<string, AbortController>();

  constructor(options: BoundedNodeProcessRunnerOptions) {
    this.#spawner = options.spawner;
  }

  cancel(requestId: string): void {
    this.#controllers.get(requestId)?.abort();
  }

  async run(request: CliProcessRequest): Promise<CliProcessResult> {
    validateRequest(request);
    if (this.#controllers.has(request.requestId)) throw providerError('PROVIDER_EXECUTION_FAILED');
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    request.signal.addEventListener('abort', forwardAbort, { once: true });
    if (request.signal.aborted) controller.abort();
    if (controller.signal.aborted) {
      request.signal.removeEventListener('abort', forwardAbort);
      throw providerError('PROVIDER_CANCELLED');
    }
    this.#controllers.set(request.requestId, controller);
    try {
      return await this.#runChild(request, controller.signal);
    } finally {
      request.signal.removeEventListener('abort', forwardAbort);
      this.#controllers.delete(request.requestId);
    }
  }

  async #runChild(request: CliProcessRequest, signal: AbortSignal): Promise<CliProcessResult> {
    let child: CliChildProcess;
    try {
      child = this.#spawner.spawn(request.launcherPath, request.args, {
        shell: false,
        windowsHide: true,
        cwd: request.cwd,
        env: Object.freeze({ ...request.env }),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      throw providerError('PROVIDER_EXECUTION_FAILED');
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdinFinished = request.stdin.length === 0;
    let pendingClose: number | null = null;
    let settled = false;
    let resolveOutcome: ((value: ProcessOutcome) => void) | undefined;
    const outcome = new Promise<ProcessOutcome>((resolve) => {
      resolveOutcome = resolve;
    });
    const settle = (value: ProcessOutcome) => {
      if (settled) return;
      settled = true;
      resolveOutcome?.(value);
    };
    const settleClose = (exitCode: number | null) => {
      const normalized = exitCode ?? 1;
      if (stdinFinished) settle({ kind: 'close', exitCode: normalized });
      else pendingClose = normalized;
    };

    child.stdout.on('data', (chunk) => {
      const bytes = Buffer.from(chunk);
      stdoutBytes += bytes.byteLength;
      if (stdoutBytes > request.stdoutLimitBytes) {
        settle({ kind: 'failure', code: 'PROVIDER_RESPONSE_TOO_LARGE' });
      } else {
        stdout.push(bytes);
      }
    });
    child.stderr.on('data', (chunk) => {
      const bytes = Buffer.from(chunk);
      stderrBytes += bytes.byteLength;
      if (stderrBytes > request.stderrLimitBytes) {
        settle({ kind: 'failure', code: 'PROVIDER_RESPONSE_TOO_LARGE' });
      } else {
        stderr.push(bytes);
      }
    });
    child.once('error', () => settle({ kind: 'failure', code: 'PROVIDER_EXECUTION_FAILED' }));
    child.stdin.once?.('error', () => {
      if (request.stdin.length > 0) {
        settle({ kind: 'failure', code: 'PROVIDER_EXECUTION_FAILED' });
      }
    });
    child.stdin.once?.('finish', () => {
      stdinFinished = true;
      if (pendingClose !== null) settle({ kind: 'close', exitCode: pendingClose });
    });
    child.once('close', settleClose);
    const timer = setTimeout(
      () => settle({ kind: 'failure', code: 'PROVIDER_TIMEOUT' }),
      request.timeoutMs,
    );
    const abort = () => settle({ kind: 'failure', code: 'PROVIDER_CANCELLED' });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();

    if (!settled && child.exitCode === null) {
      if (request.stdin.length > 0 && child.stdin.once === undefined) {
        settle({ kind: 'failure', code: 'PROVIDER_EXECUTION_FAILED' });
      } else {
        try {
          child.stdin.end(Buffer.from(request.stdin, 'utf8'));
        } catch {
          settle({ kind: 'failure', code: 'PROVIDER_EXECUTION_FAILED' });
        }
      }
    } else if (!settled && request.stdin.length > 0) {
      settle({ kind: 'failure', code: 'PROVIDER_EXECUTION_FAILED' });
    } else if (!settled && child.exitCode !== null) {
      settleClose(child.exitCode);
    }

    const completed = await outcome;
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    if (completed.kind === 'failure') {
      if (child.exitCode === null) {
        try {
          child.kill();
        } catch {
          // The bounded public error remains content-free even when local termination fails.
        }
      }
      throw providerError(completed.code);
    }
    return Object.freeze({
      exitCode: completed.exitCode,
      stdout: new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(stdout)),
      stderr: new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(stderr)),
    });
  }
}

export const createBoundedNodeProcessRunnerForTest = (
  options: BoundedNodeProcessRunnerOptions,
): CliProcessRunner => new BoundedNodeProcessRunner(options);

export const createBoundedNodeProcessRunner = (): CliProcessRunner =>
  new BoundedNodeProcessRunner({ spawner: createNodeSpawnFacade() });
