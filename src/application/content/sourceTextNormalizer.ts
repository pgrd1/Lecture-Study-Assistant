import type { ProviderFileBlock } from '../../core/ports/aiProvider';
import { normalizeUtf8Source } from '../../core/text/normalizeUtf8Source';
import { readVerifiedSource } from '../../infrastructure/providers/providerSourceMaterializer';
import { APP_ERROR_MESSAGES, AppError } from '../../shared/errors';

export const SOURCE_TEXT_LIMITS = Object.freeze({ bytes: 400_000, lines: 10_000 });
const tooLarge = () =>
  new AppError('PROVIDER_REQUEST_TOO_LARGE', APP_ERROR_MESSAGES.PROVIDER_REQUEST_TOO_LARGE);

/** Preserve every character except the UTF8 BOM and CRLF pairs; never trim or repair. */
export const normalizeSourceText = (bytes: Uint8Array): string => {
  if (bytes.byteLength > SOURCE_TEXT_LIMITS.bytes) throw tooLarge();
  let text: string;
  try {
    text = normalizeUtf8Source(bytes);
  } catch {
    throw new AppError('PROVIDER_MEDIA_UNSUPPORTED', APP_ERROR_MESSAGES.PROVIDER_MEDIA_UNSUPPORTED);
  }
  if (text.length === 0)
    throw new AppError('PROVIDER_MEDIA_UNSUPPORTED', APP_ERROR_MESSAGES.PROVIDER_MEDIA_UNSUPPORTED);
  let lines = 1;
  for (const character of text)
    if (character === '\n' && ++lines > SOURCE_TEXT_LIMITS.lines) throw tooLarge();
  return text;
};

export const readNormalizedSourceText = async (
  source: ProviderFileBlock,
  signal: AbortSignal,
): Promise<string> => {
  if (source.sizeBytes > SOURCE_TEXT_LIMITS.bytes) throw tooLarge();
  return normalizeSourceText(await readVerifiedSource(source, signal));
};
