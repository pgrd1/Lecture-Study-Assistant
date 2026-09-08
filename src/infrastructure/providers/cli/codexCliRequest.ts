import { createProviderOperation, type ProviderRequest } from '../../../core/ports/aiProvider';
import {
  CLI_DEFAULT_MODEL_DISPLAY_NAMES,
  CODEX_IMAGE_MODEL_ID,
  type JsonValue,
  type ProviderModel,
} from '../../../shared/contracts/provider';
import type { CodexImageInput } from './codexCliMedia';
import {
  type CodexArtifactRoots,
  type CodexBinding,
  type CodexRequestArtifacts,
  codexError,
  isCodexIsoTimestamp,
} from './codexCliProtocol';
import type { WindowsWorkspaceAliasLease } from './windowsWorkspaceAlias';

export const codexTimestamp = (value: string): string => {
  if (!isCodexIsoTimestamp(value)) throw codexError('PROVIDER_EXECUTION_FAILED');
  return value;
};
export const codexMilliseconds = (value: number): number => {
  if (!Number.isFinite(value) || value < 0) throw codexError('PROVIDER_EXECUTION_FAILED');
  return value;
};

export const codexModelChoices = (): readonly ProviderModel[] =>
  Object.freeze([
    Object.freeze({
      modelId: null,
      displayName: CLI_DEFAULT_MODEL_DISPLAY_NAMES.codex_cli,
      compatibility: 'unverified' as const,
    }),
    Object.freeze({
      modelId: CODEX_IMAGE_MODEL_ID,
      displayName: 'GPT-5.5 이미지 입력',
      compatibility: 'unverified' as const,
    }),
  ]);

export const snapshotCodexOperation = <Output extends JsonValue>(
  request: ProviderRequest<Output>,
) => {
  try {
    return createProviderOperation({
      requestId: request.requestId,
      feature: request.feature,
      jobId: request.jobId,
      outputSchemaId: request.outputSchemaId,
      outputJsonSchema: request.outputJsonSchema,
      parseOutput: request.parseOutput,
      blocks: request.blocks,
      timeoutMs: request.timeoutMs,
      maxOutputTokens: request.maxOutputTokens,
      signal: request.signal,
    });
  } catch {
    throw codexError('PROVIDER_EXECUTION_FAILED');
  }
};

export const assertCodexAliasLease = (
  binding: CodexBinding,
  lease: WindowsWorkspaceAliasLease,
): void => {
  const drive = lease.runtimeRoot.slice(0, 2);
  if (
    lease.providerId !== binding.providerId ||
    !/^[R-W]:\\$/u.test(lease.runtimeRoot) ||
    lease.profileRoot !== `${drive}\\profiles\\codex_cli` ||
    lease.workspaceRoot !== `${drive}\\workspace` ||
    lease.tempRoot !== `${drive}\\temp`
  )
    throw codexError('PROVIDER_UNSAFE_VERSION');
};

export const assertCodexImageManifest = (
  requestId: string,
  images: readonly CodexImageInput[],
  prepared: CodexRequestArtifacts,
  roots: CodexArtifactRoots,
): void => {
  if (
    (prepared.images?.length ?? 0) !== images.length ||
    images.some((image, index) => {
      const actual = prepared.images?.[index];
      return (
        !actual ||
        actual.fileName !== image.fileName ||
        actual.path !== `${roots.providerTempRoot}\\${requestId}\\${image.fileName}` ||
        actual.sha256 !== image.sha256 ||
        actual.sizeBytes !== image.sizeBytes
      );
    })
  )
    throw codexError('PROVIDER_UNSAFE_VERSION');
};
