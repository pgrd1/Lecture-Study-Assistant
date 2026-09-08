export type CliProcessResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

export type CliProcessRequest = Readonly<{
  requestId: string;
  launcherPath: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  stdin: string;
  timeoutMs: number;
  stdoutLimitBytes: number;
  stderrLimitBytes: number;
  /**
   * Provider-only artifact validation. It runs only after a child returns a settled process result
   * and receives no process output. The provider-bound runner invokes it with a bounded signal
   * before request cleanup while its alias is valid.
   */
  postProcessValidation?: (signal: AbortSignal) => void | Promise<void>;
  /** Exact artifact owner replaces recursive runner cleanup; never invoked for an unresolved live child. */
  requestCleanup?: (signal: AbortSignal) => Promise<void>;
  signal: AbortSignal;
  shell?: false;
}>;

export interface CliProcessRunner {
  run(request: CliProcessRequest): Promise<CliProcessResult>;
  cancel(requestId: string): void;
}
