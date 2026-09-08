import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { MetadataByteInput, SourceMetadataPort } from '../../core/ports/sourceMetadata';
import { type SourceRecord, SourceRecordSchema } from '../../shared/contracts/sourceBundle';
import { extensionOf } from '../../shared/contracts/sourceFile';
import {
  METADATA_LIMITS,
  METADATA_PARSER_VERSION,
  METADATA_POLICY_VERSION,
  type SourceMetadataFacts,
  SourceMetadataFactsSchema,
  type TrustedSourceMetadata,
  TrustedSourceMetadataSchema,
} from '../../shared/contracts/sourceMetadata';
import { readVerifiedSource } from '../providers/providerSourceMaterializer';
import { MetadataError } from './metadataError';

type WorkerOptions = Readonly<{ workerPath: string; signal?: AbortSignal; timeoutMs?: number }>;
let running = false;
let measuring = false;
export const runMetadataWorker = async (
  input: MetadataByteInput,
  options: WorkerOptions,
): Promise<SourceMetadataFacts> => {
  const timeoutMs = options.timeoutMs ?? METADATA_LIMITS.deadlineMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > METADATA_LIMITS.deadlineMs)
    throw new MetadataError('METADATA_LIMIT');
  if (options.signal?.aborted) throw new MetadataError('METADATA_CANCELLED');
  if (running) throw new MetadataError('METADATA_BUSY');
  if (
    !(input.bytes instanceof Uint8Array) ||
    !Number.isSafeInteger(input.sizeBytes) ||
    input.sizeBytes < 1 ||
    input.sizeBytes > METADATA_LIMITS.sourceBytes ||
    input.bytes.length !== input.sizeBytes
  )
    throw new MetadataError('METADATA_LIMIT');
  // Copy synchronously before awaiting: callers retain their own immutable source snapshot.
  const bytes = Uint8Array.from(input.bytes);
  if (createHash('sha256').update(bytes).digest('hex') !== input.sha256)
    throw new MetadataError('METADATA_IDENTITY');
  running = true;
  let worker: Worker | undefined;
  try {
    worker = new Worker(options.workerPath, {
      workerData: {
        extension: input.extension,
        sha256: input.sha256,
        sizeBytes: input.sizeBytes,
        bytes,
      },
      transferList: [bytes.buffer],
      env: {},
      execArgv: [],
      stdout: true,
      stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
    });
    const active = worker;
    return await new Promise<SourceMetadataFacts>((resolve, reject) => {
      let settled = false;
      let diagnosticBytes = 0;
      const finish = (error?: MetadataError, value?: SourceMetadataFacts): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', cancel);
        if (error) reject(error);
        else if (value) resolve(value);
        else reject(new MetadataError('METADATA_INVALID'));
      };
      const cancel = () => finish(new MetadataError('METADATA_CANCELLED'));
      const timer = setTimeout(() => finish(new MetadataError('METADATA_TIMEOUT')), timeoutMs);
      options.signal?.addEventListener('abort', cancel, { once: true });
      if (options.signal?.aborted) cancel();
      const discard = (chunk: Buffer) => {
        diagnosticBytes += chunk.length;
        if (diagnosticBytes > 4096) finish(new MetadataError('METADATA_LIMIT'));
      };
      active.stdout?.on('data', discard);
      active.stderr?.on('data', discard);
      active.once('error', () => finish(new MetadataError('METADATA_INVALID')));
      active.once('exit', () => finish(new MetadataError('METADATA_INVALID')));
      active.once('message', (message: unknown) => {
        try {
          if (
            typeof message !== 'string' ||
            Buffer.byteLength(message) > METADATA_LIMITS.outputBytes
          )
            throw new MetadataError('METADATA_LIMIT');
          const result: unknown = JSON.parse(message);
          if (
            typeof result === 'object' &&
            result !== null &&
            Object.keys(result).length === 1 &&
            'error' in result &&
            [
              'METADATA_UNSUPPORTED',
              'METADATA_INVALID',
              'METADATA_LIMIT',
              'METADATA_IDENTITY',
            ].includes(String(result.error))
          )
            return finish(new MetadataError(result.error as 'METADATA_INVALID'));
          finish(undefined, SourceMetadataFactsSchema.parse(result));
        } catch {
          finish(new MetadataError('METADATA_INVALID'));
        }
      });
    });
  } finally {
    try {
      if (worker) await worker.terminate();
    } finally {
      running = false;
    }
  }
};

export class LocalSourceMetadata implements SourceMetadataPort {
  readonly #workerPath: string;
  readonly #cache = new Map<string, SourceMetadataFacts>();
  constructor(options: Readonly<{ workerPath?: string }> = {}) {
    this.#workerPath =
      options.workerPath ??
      join(
        typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url)),
        'metadata-worker.mjs',
      );
  }
  async measure(source: SourceRecord, signal?: AbortSignal): Promise<TrustedSourceMetadata> {
    if (measuring) throw new MetadataError('METADATA_BUSY');
    measuring = true;
    try {
      const declared = SourceRecordSchema.parse(source);
      const extension = extensionOf(declared.originalFileName);
      const bytes = await readVerifiedSource(
        {
          role: 'user',
          kind: 'source_file',
          sourceId: declared.id,
          filePath: declared.stagedPath,
          mediaType: declared.mediaType,
          sha256: declared.sha256,
          sizeBytes: declared.sizeBytes,
        },
        signal,
      );
      const key = `${declared.sha256}:${declared.sizeBytes}:${extension}:${METADATA_PARSER_VERSION}:${METADATA_POLICY_VERSION}`;
      const cached = this.#cache.get(key);
      const facts =
        cached ??
        (await runMetadataWorker(
          { bytes, extension, sha256: declared.sha256, sizeBytes: declared.sizeBytes },
          { workerPath: this.#workerPath, ...(signal ? { signal } : {}) },
        ));
      if (!cached) {
        if (this.#cache.size >= 32) this.#cache.clear();
        this.#cache.set(key, facts);
      }
      return TrustedSourceMetadataSchema.parse({
        sourceId: declared.id,
        sha256: declared.sha256,
        sizeBytes: declared.sizeBytes,
        parserVersion: METADATA_PARSER_VERSION,
        policyVersion: METADATA_POLICY_VERSION,
        facts,
      });
    } catch (error) {
      if (error instanceof MetadataError) throw error;
      throw new MetadataError(signal?.aborted ? 'METADATA_CANCELLED' : 'METADATA_IDENTITY');
    } finally {
      measuring = false;
    }
  }
}
