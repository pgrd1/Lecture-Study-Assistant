import { Buffer } from 'node:buffer';
import type {
  ProviderBlock,
  ProviderFileBlock,
  ProviderTextBlock,
} from '../../../core/ports/aiProvider';
import type { ApiProviderId, JsonValue } from '../../../shared/contracts/provider';
import {
  assertMediaActive,
  mediaError,
  ProviderSourceMaterializer,
  type ProviderSourceMaterializerPort,
  readVerifiedSource,
  sourceMime,
} from '../providerSourceMaterializer';
import { countBoundedJsonBytes } from './boundedJsonBytes';

export const PROVIDER_BODY_LIMITS: Readonly<Record<ApiProviderId, number>> = Object.freeze({
  gemini_api: 96_000_000,
  openai_api: 64_000_000,
  claude_api: 32_000_000,
});
const MODELS: Readonly<Record<ApiProviderId, readonly string[]>> = {
  gemini_api: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3.1-pro-preview', 'gemini-3.8-flash'],
  openai_api: ['gpt-4.1', 'gpt-4.1-2025-04-14', 'gpt-4o', 'gpt-4o-2024-08-06'],
  claude_api: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-sonnet-4-5-20250929'],
};
type JsonObject = Readonly<Record<string, JsonValue>>;
const object = (value: JsonValue): JsonObject => {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw mediaError('PROVIDER_EXECUTION_FAILED');
  return value as JsonObject;
};
const array = (value: JsonValue | undefined): readonly JsonValue[] => {
  if (!Array.isArray(value)) throw mediaError('PROVIDER_EXECUTION_FAILED');
  return value;
};
const textValue = (value: JsonValue | undefined): string => {
  if (typeof value !== 'string') throw mediaError('PROVIDER_EXECUTION_FAILED');
  return value;
};
const attach = (
  providerId: ApiProviderId,
  base: JsonValue,
  parts: readonly JsonValue[],
): JsonValue => {
  const body = object(base);
  if (providerId === 'gemini_api')
    return { ...body, input: [{ type: 'text', text: textValue(body.input) }, ...parts] };
  if (providerId === 'openai_api')
    return {
      ...body,
      input: array(body.input).map((entry) => {
        const message = object(entry);
        return message.role === 'user'
          ? { ...message, content: [...array(message.content), ...parts] }
          : message;
      }),
    };
  return {
    ...body,
    messages: array(body.messages).map((entry) => {
      const message = object(entry);
      return {
        ...message,
        content: [{ type: 'text', text: textValue(message.content) }, ...parts],
      };
    }),
  };
};
const nativePart = (
  providerId: ApiProviderId,
  file: ProviderFileBlock,
  index: number,
  data: string,
): JsonValue => {
  const mime = sourceMime(file);
  if (providerId === 'gemini_api') return { type: file.mediaType, mime_type: mime, data };
  if (providerId === 'openai_api')
    return file.mediaType === 'image'
      ? { type: 'input_image', image_url: `data:${mime};base64,${data}`, detail: 'auto' }
      : {
          type: 'input_file',
          filename: `source-${index}.pdf`,
          file_data: `data:application/pdf;base64,${data}`,
        };
  return {
    type: file.mediaType === 'image' ? 'image' : 'document',
    source: { type: 'base64', media_type: mime, data },
  };
};
const verifyMedia = (mime: string, bytes: Buffer): void => {
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
  } else if (mime === 'image/jpeg') {
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
  } else if (mime === 'application/pdf') {
    if (
      !bytes.subarray(0, 8).toString('ascii').startsWith('%PDF-') ||
      !bytes.subarray(Math.max(0, bytes.length - 1024)).includes(Buffer.from('%%EOF'))
    )
      throw mediaError();
  } else if (mime === 'audio/m4a') {
    if (
      bytes.length < 24 ||
      bytes.readUInt32BE(0) < 16 ||
      bytes.readUInt32BE(0) > bytes.length ||
      bytes.toString('ascii', 4, 8) !== 'ftyp' ||
      bytes.toString('ascii', 8, 12) !== 'M4A '
    )
      throw mediaError();
  } else if (mime === 'audio/wav') {
    if (
      bytes.length < 44 ||
      bytes.toString('ascii', 0, 4) !== 'RIFF' ||
      bytes.toString('ascii', 8, 12) !== 'WAVE'
    )
      throw mediaError();
  } else if (mime === 'audio/mpeg') {
    if (
      bytes.length < 4 ||
      !(
        bytes.toString('ascii', 0, 3) === 'ID3' ||
        (bytes[0] === 255 && (bytes.readUInt8(1) & 224) === 224)
      )
    )
      throw mediaError();
  }
  if (
    mime.startsWith('image/') &&
    (width < 1 || height < 1 || width > 8000 || height > 8000 || width * height > 32_000_000)
  )
    throw mediaError();
};
type Preparation = Readonly<{
  providerId: ApiProviderId;
  modelId: string;
  requestId: string;
  blocks: readonly ProviderBlock[];
  signal: AbortSignal;
  build: (blocks: readonly ProviderTextBlock[]) => JsonValue;
  materializer?: ProviderSourceMaterializerPort;
}>;
const cleanupMediaWorkspace = async (
  materializer: ProviderSourceMaterializerPort,
  requestId: string,
): Promise<void> => {
  try {
    await materializer.cleanup(requestId);
  } catch {
    throw mediaError('PROVIDER_RESIDUAL_DATA');
  }
};
export const prepareApiMediaBody = async (input: Preparation): Promise<JsonValue> => {
  assertMediaActive(input.signal);
  const files = input.blocks.filter(
    (block): block is ProviderFileBlock => block.kind === 'source_file',
  );
  const text = input.blocks.map(
    (block): ProviderTextBlock =>
      block.kind === 'source_file'
        ? {
            role: 'user',
            kind: 'source',
            text: JSON.stringify({
              sourceId: block.sourceId,
              attachmentIndex: files.indexOf(block),
            }),
          }
        : block,
  );
  const base = input.build(text);
  const limit = files.length ? PROVIDER_BODY_LIMITS[input.providerId] : 8 * 1024 * 1024;
  if (files.length && !MODELS[input.providerId].includes(input.modelId)) throw mediaError();
  let rawBytes = 0;
  for (const file of files) {
    sourceMime(file);
    if (
      (input.providerId !== 'gemini_api' && file.mediaType === 'audio') ||
      file.mediaType === 'video'
    )
      throw mediaError();
    if (
      !Number.isSafeInteger(file.sizeBytes) ||
      file.sizeBytes < 1 ||
      file.sizeBytes > 64_000_000 ||
      (file.mediaType === 'document' && file.sizeBytes >= 50_000_000) ||
      (input.providerId === 'claude_api' &&
        file.mediaType === 'image' &&
        file.sizeBytes > 5_000_000)
    )
      throw mediaError('PROVIDER_REQUEST_TOO_LARGE');
    rawBytes += file.sizeBytes;
  }
  if (
    files.length > 20 ||
    rawBytes > 64_000_000 ||
    (input.providerId === 'openai_api' && rawBytes >= 50_000_000)
  )
    throw mediaError('PROVIDER_REQUEST_TOO_LARGE');
  const emptyBody = files.length
    ? attach(
        input.providerId,
        base,
        files.map((file, index) => nativePart(input.providerId, file, index, '')),
      )
    : base;
  const encodedBytes =
    countBoundedJsonBytes(emptyBody, limit) +
    files.reduce((total, file) => total + 4 * Math.ceil(file.sizeBytes / 3), 0);
  if (encodedBytes > limit) throw mediaError('PROVIDER_REQUEST_TOO_LARGE');
  if (!files.length) return base;
  const materializer = input.materializer ?? new ProviderSourceMaterializer();
  // A failed acquisition has no caller-owned workspace. The materializer cleans
  // its own partial failure; a rejected duplicate must not release another owner.
  const materialized = await materializer.materialize(input.requestId, files, input.signal);
  try {
    if (materialized.files.length !== files.length) throw mediaError('PROVIDER_EXECUTION_FAILED');
    const parts: JsonValue[] = [];
    for (const [index, file] of materialized.files.entries()) {
      const bytes = await readVerifiedSource(
        { ...file, filePath: file.absolutePath },
        input.signal,
      );
      verifyMedia(file.mimeType, bytes);
      const declared = files[index];
      if (
        !declared ||
        declared.sourceId !== file.sourceId ||
        declared.sha256 !== file.sha256 ||
        declared.sizeBytes !== file.sizeBytes
      )
        throw mediaError('PROVIDER_EXECUTION_FAILED');
      parts.push(nativePart(input.providerId, declared, index, bytes.toString('base64')));
    }
    assertMediaActive(input.signal);
    const body = attach(input.providerId, base, parts);
    if (countBoundedJsonBytes(body, limit) !== encodedBytes)
      throw mediaError('PROVIDER_EXECUTION_FAILED');
    return body;
  } finally {
    // Residual data outranks successful execution and ordinary provider failure.
    await cleanupMediaWorkspace(materializer, input.requestId);
  }
};
