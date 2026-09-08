import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';
import * as pdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs';
import 'pdfjs-dist/legacy/build/pdf.mjs';
import { METADATA_LIMITS } from '../../shared/contracts/sourceMetadata';
import { MetadataError } from './metadataError';
import { sealParserAccess } from './parserGuard';
import { parseSourceMetadata } from './parseSourceMetadata';

// All module paths are fixed local package imports. PDF.js uses this preloaded local worker.
Object.assign(globalThis, { pdfjsWorker: pdfWorker });
const require = createRequire(import.meta.url);
// Electron's ASAR ESM loader uses public fs reads for lazy imports. Preload the sole
// music parser we accept before sealing fs; this is a fixed packaged code path.
await import(
  pathToFileURL(join(dirname(require.resolve('music-metadata')), 'mp4/MP4Parser.js')).href
);
sealParserAccess();
try {
  const result = await parseSourceMetadata(workerData);
  const message = JSON.stringify(result);
  if (Buffer.byteLength(message) > METADATA_LIMITS.outputBytes)
    throw new MetadataError('METADATA_LIMIT');
  parentPort?.postMessage(message);
} catch (error) {
  parentPort?.postMessage(
    JSON.stringify({ error: error instanceof MetadataError ? error.code : 'METADATA_INVALID' }),
  );
}
