import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LocalSourceMetadata,
  runMetadataWorker,
} from '../../../src/infrastructure/metadata/localSourceMetadata';
import { MetadataError } from '../../../src/infrastructure/metadata/metadataError';
import {
  METADATA_PARSER_VERSION,
  METADATA_POLICY_VERSION,
} from '../../../src/shared/contracts/sourceMetadata';
import { compressedPdf } from '../../fixtures/metadata/pdfTree';
import { m4a, pdf, png, pptxParts, wav, zip } from '../../fixtures/metadata/synthetic';
import { fixtureFile } from '../../testkit/tempDirectory';

const input = (bytes = wav()) => ({
  bytes,
  extension: '.wav',
  sha256: createHash('sha256').update(bytes).digest('hex'),
  sizeBytes: bytes.length,
});
const workerPath = resolve('.vite/build/metadata-worker.mjs');
describe('terminable metadata worker and source boundary', () => {
  it('bounds compressed object-stream processing and recovers after tree rejection/cancellation', async () => {
    const bytes = compressedPdf(8 * 1024 * 1024);
    expect(bytes.length).toBeLessThan(10000);
    await expect(
      runMetadataWorker({ ...input(bytes), extension: '.pdf' }, { workerPath }),
    ).resolves.toEqual({ kind: 'pdf', pageCount: 1 });
    await expect(
      runMetadataWorker(
        { ...input(compressedPdf(8 * 1024 * 1024, 2)), extension: '.pdf' },
        { workerPath },
      ),
    ).rejects.toMatchObject({ code: 'METADATA_INVALID' });
    // Startup/deadline cancellation is externally enforced; not a claim it interrupted inflate itself.
    await expect(
      runMetadataWorker({ ...input(bytes), extension: '.pdf' }, { workerPath, timeoutMs: 1 }),
    ).rejects.toMatchObject({ code: 'METADATA_TIMEOUT' });
    await expect(
      runMetadataWorker({ ...input(png), extension: '.png' }, { workerPath }),
    ).resolves.toMatchObject({ encodedWidth: 1 });
  });
  it('rejects underreported and overreported PDF page counts through the real worker', async () => {
    for (const count of ['1 ', '11']) {
      const bytes = Buffer.from(pdf().toString().replace('/Count 10', `/Count ${count}`));
      await expect(
        runMetadataWorker({ ...input(bytes), extension: '.pdf' }, { workerPath }),
      ).rejects.toMatchObject({ code: 'METADATA_INVALID' });
    }
  });
  it('denies network, filesystem reopen and writes inside a real guarded worker', async () => {
    expect(
      await runMetadataWorker(input(), {
        workerPath: resolve('tests/fixtures/metadata/guard-probe.mjs'),
      }),
    ).toMatchObject({ lineCount: 6 });
  });
  it('runs real packaged-local imports with only byte input', async () => {
    expect(await runMetadataWorker(input(), { workerPath })).toMatchObject({
      kind: 'audio',
      durationSeconds: 1,
    });
    expect(await runMetadataWorker({ ...input(pdf()), extension: '.pdf' }, { workerPath })).toEqual(
      { kind: 'pdf', pageCount: 10 },
    );
    for (const [bytes, extension] of [
      [m4a(), '.m4a'],
      [png, '.png'],
      [zip(pptxParts), '.pptx'],
    ] as const)
      expect(await runMetadataWorker({ ...input(bytes), extension }, { workerPath })).toBeDefined();
  });
  it('terminates and awaits an actually stuck worker on deadline and cancellation', async () => {
    const stuck = resolve('tests/fixtures/metadata/stuck-worker.cjs');
    await expect(
      runMetadataWorker(input(), { workerPath: stuck, timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: 'METADATA_TIMEOUT' });
    const abort = new AbortController();
    const task = runMetadataWorker(input(), { workerPath: stuck, signal: abort.signal });
    setTimeout(() => abort.abort(), 100);
    await expect(task).rejects.toMatchObject({ code: 'METADATA_CANCELLED' });
    // A later real worker runs after termination; the single-worker slot has been released.
    expect(await runMetadataWorker(input(), { workerPath })).toMatchObject({ durationSeconds: 1 });
  });
  it('rejects invalid messages, budgets and pre-aborted work', async () => {
    for (const timeoutMs of [0, -1, NaN, Infinity, 15001])
      await expect(runMetadataWorker(input(), { workerPath, timeoutMs })).rejects.toBeInstanceOf(
        MetadataError,
      );
    const abort = new AbortController();
    abort.abort();
    await expect(
      runMetadataWorker(input(), { workerPath, signal: abort.signal }),
    ).rejects.toMatchObject({ code: 'METADATA_CANCELLED' });
    await expect(
      runMetadataWorker(input(), {
        workerPath: resolve('tests/fixtures/metadata/invalid-worker.cjs'),
      }),
    ).rejects.toMatchObject({ code: 'METADATA_INVALID' });
  });
  it('reads declared original once, binds small facts to source/hash/parser/policy and refuses mutated bytes', async () => {
    const bytes = wav();
    const path = await fixtureFile('original.wav', bytes);
    const source = {
      id: '11111111-1111-4111-8111-111111111111',
      bundleId: '22222222-2222-4222-8222-222222222222',
      ordinal: 0,
      originalFileName: 'original.wav',
      mediaType: 'audio' as const,
      stagedPath: path,
      sha256: input(bytes).sha256,
      sizeBytes: bytes.length,
    };
    const port = new LocalSourceMetadata({ workerPath });
    const pending = port.measure(source);
    await expect(
      port.measure({ ...source, stagedPath: 'invalid-unopened-path' }),
    ).rejects.toMatchObject({ code: 'METADATA_BUSY' });
    await pending;
    const result = await port.measure(source);
    expect(result).toMatchObject({
      sourceId: source.id,
      sha256: source.sha256,
      parserVersion: METADATA_PARSER_VERSION,
      policyVersion: METADATA_POLICY_VERSION,
      facts: { durationSeconds: 1 },
    });
    expect(await port.measure(source)).toEqual(result);
    await expect(port.measure({ ...source, sha256: '0'.repeat(64) })).rejects.toThrow();
  });
});
