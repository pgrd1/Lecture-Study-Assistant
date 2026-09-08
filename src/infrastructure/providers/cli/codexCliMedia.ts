import type { Buffer } from 'node:buffer';
import { extname, join, resolve } from 'node:path';
import type {
  ProviderBlock,
  ProviderFileBlock,
  ProviderTextBlock,
} from '../../../core/ports/aiProvider';
import { snapshotProviderFileBlock } from '../../../core/ports/aiProvider';
import { CODEX_IMAGE_MODEL_ID, type JsonValue } from '../../../shared/contracts/provider';
import { countBoundedJsonBytes } from '../api/boundedJsonBytes';
import {
  mediaError,
  type ProviderSourceMaterializerPort,
  readVerifiedSource,
  sourceMime,
} from '../providerSourceMaterializer';

export type CodexImageInput = Readonly<{
  fileName: string;
  bytes: Uint8Array;
  sizeBytes: number;
  sha256: string;
}>;
export type CodexImageManifest = Readonly<{
  fileName: string;
  path: string;
  sizeBytes: number;
  sha256: string;
}>;

export const preflightCodexMedia = (
  modelId: string | null,
  blocks: readonly ProviderBlock[],
  schema: Readonly<Record<string, JsonValue>>,
  maxOutputTokens: number,
) => {
  if (modelId !== null && modelId !== CODEX_IMAGE_MODEL_ID)
    throw mediaError('PROVIDER_MODEL_INCOMPATIBLE');
  const files = Object.freeze(
    blocks
      .filter((block): block is ProviderFileBlock => block.kind === 'source_file')
      .map(snapshotProviderFileBlock),
  );
  if (files.length && modelId !== CODEX_IMAGE_MODEL_ID)
    throw mediaError('PROVIDER_MODEL_INCOMPATIBLE');
  if (files.length > 2) throw mediaError('PROVIDER_REQUEST_TOO_LARGE');
  for (const file of files) {
    if (file.mediaType !== 'image' || !['image/png', 'image/jpeg'].includes(sourceMime(file)))
      throw mediaError();
    if (file.sizeBytes > 5_000_000) throw mediaError('PROVIDER_REQUEST_TOO_LARGE');
  }
  const text = Object.freeze(
    blocks.map(
      (block): ProviderTextBlock =>
        block.kind === 'source_file'
          ? Object.freeze({
              role: 'user',
              kind: 'source',
              text: JSON.stringify({
                sourceId: block.sourceId,
                attachmentIndex: files.findIndex((file) => file.sourceId === block.sourceId),
              }),
            })
          : Object.freeze({ role: block.role, kind: block.kind, text: block.text }),
    ),
  );
  if (new Set(files.map((file) => file.sourceId)).size !== files.length)
    throw mediaError('PROVIDER_EXECUTION_FAILED');
  // Conservative application budget: <=64 KiB complete escaped input, two bounded
  // images (32,768 token reserve each), 128,000 model output, 32,768 runtime overhead.
  // Total reserve 291,840 is below the documented GPT-5.5 1,050,000 context window.
  const limit = files.length ? 65_536 : 1024 * 1024;
  countBoundedJsonBytes(
    { blocks: text, outputJsonSchema: schema, responseSchema: schema },
    limit - 1,
  );
  if (
    files.length &&
    (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 65_536)
  )
    throw mediaError('PROVIDER_REQUEST_TOO_LARGE');
  return Object.freeze({ files, text });
};

const verifyImage = (mime: string, bytes: Buffer): void => {
  let width = 0;
  let height = 0;
  if (mime === 'image/png') {
    if (
      bytes.length < 33 ||
      bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
      bytes.toString('ascii', 12, 16) !== 'IHDR'
    )
      throw mediaError();
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
  } else {
    if (bytes[0] !== 255 || bytes[1] !== 216) throw mediaError();
    for (let offset = 2; offset + 8 < bytes.length; ) {
      if (bytes[offset] !== 255) throw mediaError();
      const marker = bytes.readUInt8(offset + 1);
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2 || offset + length + 2 > bytes.length) throw mediaError();
      if ([192, 193, 194].includes(marker)) {
        height = bytes.readUInt16BE(offset + 5);
        width = bytes.readUInt16BE(offset + 7);
        break;
      }
      offset += length + 2;
    }
  }
  if (width < 1 || height < 1 || width > 2048 || height > 2048) throw mediaError();
};

const cleanupImages = async (
  materializer: ProviderSourceMaterializerPort,
  requestId: string,
): Promise<void> => {
  try {
    await materializer.cleanup(requestId);
  } catch {
    throw mediaError('PROVIDER_RESIDUAL_DATA');
  }
};

export const prepareCodexImages = async (
  requestId: string,
  files: readonly ProviderFileBlock[],
  signal: AbortSignal,
  materializer: ProviderSourceMaterializerPort,
): Promise<readonly CodexImageInput[]> => {
  if (!files.length) return Object.freeze([]);
  // Acquisition owns its rejected partial work. Never cleanup another active acquisition.
  const materialized = await materializer.materialize(requestId, files, signal);
  try {
    if (materialized.files.length !== files.length) throw mediaError('PROVIDER_EXECUTION_FAILED');
    const result: CodexImageInput[] = [];
    for (const [index, file] of materialized.files.entries()) {
      const declared = files[index];
      if (!declared) throw mediaError('PROVIDER_EXECUTION_FAILED');
      const extension = extname(declared.filePath).toLowerCase();
      const relativePath = `sources/${String(index).padStart(3, '0')}-image${extension}`;
      if (
        file.relativePath !== relativePath ||
        file.absolutePath !== join(materialized.workspacePath, relativePath) ||
        resolve(materialized.workspacePath) !== materialized.workspacePath ||
        file.filePath !== declared.filePath ||
        file.sourceId !== declared.sourceId ||
        file.sha256 !== declared.sha256 ||
        file.sizeBytes !== declared.sizeBytes ||
        file.mediaType !== 'image' ||
        file.mimeType !== sourceMime(declared)
      )
        throw mediaError('PROVIDER_EXECUTION_FAILED');
      const bytes = await readVerifiedSource({ ...declared, filePath: file.absolutePath }, signal);
      verifyImage(file.mimeType, bytes);
      result.push(
        Object.freeze({
          fileName: `image-${String(index).padStart(3, '0')}${file.mimeType === 'image/png' ? '.png' : '.jpg'}`,
          bytes,
          sizeBytes: declared.sizeBytes,
          sha256: declared.sha256,
        }),
      );
    }
    return Object.freeze(result);
  } finally {
    await cleanupImages(materializer, requestId);
  }
};
