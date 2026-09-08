import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { app } from 'electron';
import { runMetadataWorker } from '../../../src/infrastructure/metadata/localSourceMetadata';
import { MetadataError } from '../../../src/infrastructure/metadata/metadataError';

// This entry exists only in uniquely named smoke packages, never normal app builds.
const root = process.env.STUDYAPP_METADATA_SMOKE_ROOT;
if (!root || !/^metadata-smoke-[a-f0-9-]{36}$/u.test(root.split(/[\\/]/u).at(-1) ?? ''))
  app.exit(2);
const directory = resolve(root as string);
app.setPath('userData', join(directory, 'profile'));
app.disableHardwareAcceleration();
const timer = setTimeout(() => app.exit(3), 60_000);
let currentCase = 0;
void (async () => {
  await app.whenReady();
  try {
    const cases = JSON.parse(await readFile(join(directory, 'inputs.json'), 'utf8')) as {
      extension: string;
      base64: string;
      expectInvalid: boolean;
    }[];
    const results = [];
    for (const fixture of cases) {
      const bytes = Buffer.from(fixture.base64, 'base64');
      results.push(
        await runMetadataWorker(
          {
            bytes,
            extension: fixture.extension,
            sizeBytes: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          },
          { workerPath: join(app.getAppPath(), '.vite/build/metadata-worker.mjs') },
        ).catch((error: unknown) => {
          if (
            fixture.expectInvalid &&
            error instanceof MetadataError &&
            error.code === 'METADATA_INVALID'
          )
            return { error: error.code };
          throw error;
        }),
      );
      currentCase++;
    }
    await writeFile(
      join(directory, 'result.json'),
      JSON.stringify({ electron: process.versions.electron, node: process.versions.node, results }),
    );
    clearTimeout(timer);
    app.exit(0);
  } catch (failure) {
    await writeFile(
      join(directory, 'case-failure.json'),
      JSON.stringify({
        currentCase,
        error: failure instanceof Error ? failure.message : 'unknown',
      }),
    );
    // Synthetic-only smoke diagnostics; production workers keep failures closed and source-free.
    const probe = new Worker(join(app.getAppPath(), '.vite/build/metadata-worker.mjs'), {
      workerData: {},
      stdout: true,
      stderr: true,
    });
    probe.once('error', async (error) => {
      await writeFile(join(directory, 'failure.txt'), error.message);
      await probe.terminate();
      clearTimeout(timer);
      app.exit(1);
    });
    probe.once('message', async (message: unknown) => {
      await writeFile(join(directory, 'failure.txt'), String(message));
      await probe.terminate();
      clearTimeout(timer);
      app.exit(1);
    });
  }
})();
