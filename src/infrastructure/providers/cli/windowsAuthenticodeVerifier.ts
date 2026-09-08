import { Buffer } from 'node:buffer';
import type { ProviderConnectionOperation } from '../../../core/ports/aiProvider';
import type { CliProcessRunner } from '../../../core/ports/cliProcessRunner';
import type { CliExecutableFileAccess, CliFileHasher } from './cliFileIntegrity';
import {
  assertProviderConnectionActive,
  isCanonicalAbsoluteWindowsPath,
  secureExactPath,
  unsafeVersion,
} from './cliFileIntegrity';
import { runVerifiedWindowsPowerShell } from './windowsPowerShell';

export type CliSignerClassification = 'google' | 'openai' | 'nodejs';

export const AUTHENTICODE_TARGET_ENVIRONMENT_KEY = 'STUDYAPP_CLI_SIGNATURE_TARGET' as const;

const WINDOWS_AUTHENTICODE_SCRIPT = `$ErrorActionPreference = 'Stop'
$target = [Environment]::GetEnvironmentVariable('STUDYAPP_CLI_SIGNATURE_TARGET', 'Process')
if ([string]::IsNullOrWhiteSpace($target)) { throw 'Missing signature target.' }
$signature = Get-AuthenticodeSignature -LiteralPath $target -ErrorAction Stop
$certificate = $signature.SignerCertificate
if ($null -eq $certificate) { throw 'Missing signer certificate.' }
[pscustomobject]@{
  status = [string]$signature.Status
  subject = [string]$certificate.Subject
  thumbprint = [string]$certificate.Thumbprint
} | ConvertTo-Json -Compress`;

export const WINDOWS_AUTHENTICODE_ENCODED_COMMAND = Buffer.from(
  WINDOWS_AUTHENTICODE_SCRIPT,
  'utf16le',
).toString('base64');

export const AUTHENTICODE_PUBLISHER_SUBJECTS = Object.freeze({
  google: Object.freeze(['CN=Google LLC, O=Google LLC, L=Mountain View, S=California, C=US']),
  openai: Object.freeze(['CN=OpenAI, O=OpenAI, L=San Francisco, S=California, C=US']),
  nodejs: Object.freeze([
    'CN=OpenJS Foundation, O=OpenJS Foundation, L=San Francisco, S=California, C=US',
  ]),
} as const satisfies Readonly<Record<CliSignerClassification, readonly string[]>>);

export type AuthenticodeEvidence = Readonly<{
  signerClassification: CliSignerClassification;
  certificateThumbprint: string;
}>;

export interface CliSignatureVerifier {
  verify(
    canonicalTargetPath: string,
    expectedClassification: CliSignerClassification,
    operation: ProviderConnectionOperation,
  ): Promise<AuthenticodeEvidence>;
}

type WindowsAuthenticodeVerifierOptions = Readonly<{
  runner: CliProcessRunner;
  files: CliExecutableFileAccess;
  hasher: CliFileHasher;
}>;

const parseSignatureOutput = (
  value: string,
): Readonly<{ status: string; subject: string; thumbprint: string }> => {
  if (value.length === 0 || Buffer.byteLength(value, 'utf8') > 4_096) throw unsafeVersion();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw unsafeVersion();
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw unsafeVersion();
  }
  const object = parsed as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== 'status' ||
    keys[1] !== 'subject' ||
    keys[2] !== 'thumbprint' ||
    typeof object.status !== 'string' ||
    typeof object.subject !== 'string' ||
    typeof object.thumbprint !== 'string'
  ) {
    throw unsafeVersion();
  }
  return Object.freeze({
    status: object.status,
    subject: object.subject,
    thumbprint: object.thumbprint,
  });
};

class FixedWindowsAuthenticodeVerifier implements CliSignatureVerifier {
  readonly #options: WindowsAuthenticodeVerifierOptions;

  constructor(options: WindowsAuthenticodeVerifierOptions) {
    this.#options = Object.freeze({ ...options });
  }

  async verify(
    canonicalTargetPath: string,
    expectedClassification: CliSignerClassification,
    operation: ProviderConnectionOperation,
  ): Promise<AuthenticodeEvidence> {
    try {
      assertProviderConnectionActive(operation);
      if (!isCanonicalAbsoluteWindowsPath(canonicalTargetPath)) throw unsafeVersion();
      await secureExactPath(this.#options.files, canonicalTargetPath, operation);
      assertProviderConnectionActive(operation);
      const result = await runVerifiedWindowsPowerShell(
        this.#options,
        {
          encodedCommand: WINDOWS_AUTHENTICODE_ENCODED_COMMAND,
          env: Object.freeze({ [AUTHENTICODE_TARGET_ENVIRONMENT_KEY]: canonicalTargetPath }),
          timeoutMs: 10_000,
          stdoutLimitBytes: 4_096,
          stderrLimitBytes: 1_024,
        },
        operation,
      );
      assertProviderConnectionActive(operation);
      if (result.exitCode !== 0) throw unsafeVersion();
      const output = parseSignatureOutput(result.stdout);
      if (
        output.status !== 'Valid' ||
        !AUTHENTICODE_PUBLISHER_SUBJECTS[expectedClassification].includes(output.subject) ||
        !/^[A-F0-9]{40}$/u.test(output.thumbprint)
      ) {
        throw unsafeVersion();
      }
      return Object.freeze({
        signerClassification: expectedClassification,
        certificateThumbprint: output.thumbprint,
      });
    } catch {
      assertProviderConnectionActive(operation);
      throw unsafeVersion();
    }
  }
}

export const createWindowsAuthenticodeVerifier = (
  options: WindowsAuthenticodeVerifierOptions,
): CliSignatureVerifier => {
  const keys = Object.keys(options).sort();
  if (keys.length !== 3 || keys[0] !== 'files' || keys[1] !== 'hasher' || keys[2] !== 'runner') {
    throw unsafeVersion();
  }
  return new FixedWindowsAuthenticodeVerifier(options);
};

export const createWindowsAuthenticodeVerifierForTest = createWindowsAuthenticodeVerifier;
