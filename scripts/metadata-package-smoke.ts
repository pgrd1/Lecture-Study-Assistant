import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { listPackage } from '@electron/asar';
import { progressiveJpeg } from '../tests/fixtures/metadata/imageStructures';
import { nestedPdfObjects, pdfObjects } from '../tests/fixtures/metadata/pdfTree';
import { jpeg, m4a, pdf, png, pptxParts, wav, zip } from '../tests/fixtures/metadata/synthetic';

const id = `metadata-smoke-${randomUUID()}`;
const root = resolve('out', id);
await mkdir(root, { recursive: false });
const mp3 = Buffer.alloc(834);
mp3.writeUInt32BE(0xfffb9000, 0);
mp3.writeUInt32BE(0xfffb9000, 417);
const fixtures = [
  [wav(), '.wav'],
  [m4a(), '.m4a'],
  [pdf(), '.pdf'],
  [zip(pptxParts), '.pptx'],
  [png, '.png'],
  [mp3, '.mp3'],
  [jpeg(6), '.jpeg'],
  [Buffer.from('한글\r\nx'), '.txt'],
  [pdfObjects(nestedPdfObjects), '.pdf'],
  [Buffer.from(pdf().toString().replace('/Count 10', '/Count 1 ')), '.pdf'],
  [
    pdfObjects(
      nestedPdfObjects.map((object, i) =>
        i === 2 ? object.replace('/Count 2', '/Count 1') : object,
      ),
    ),
    '.pdf',
  ],
  [progressiveJpeg, '.jpeg'],
] as const;
await writeFile(
  join(root, 'inputs.json'),
  JSON.stringify(
    fixtures.map(([bytes, extension], index) => ({
      extension,
      base64: bytes.toString('base64'),
      expectInvalid: index === 9 || index === 10,
    })),
  ),
);
const run = (executable: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, windowsHide: true, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`SMOKE_EXIT_${code}`)),
    );
  });
await run(process.execPath, ['node_modules/@electron-forge/cli/dist/electron-forge-package.js'], {
  ...process.env,
  STUDYAPP_METADATA_SMOKE_ID: id,
});
const executable = join(root, 'Lecture Study Assistant-win32-x64', 'Lecture Study Assistant.exe');
const archive = join(root, 'Lecture Study Assistant-win32-x64', 'resources', 'app.asar');
const entries = listPackage(archive, { isPack: false }).map((name) => name.replaceAll('\\', '/'));
for (const forbidden of [
  '/src/',
  '/tests/',
  '/.env',
  '/.codex/',
  '/out/',
  '/node_modules/typescript/',
  '/node_modules/vitest/',
  '/node_modules/image-size/',
])
  assert.equal(
    entries.some((name) => name.startsWith(forbidden)),
    false,
    forbidden,
  );
for (const required of [
  '/.vite/build/metadata-worker.mjs',
  '/node_modules/music-metadata/lib/index.js',
  '/node_modules/pdfjs-dist/legacy/build/pdf.mjs',
  '/node_modules/pdf-lib/cjs/index.js',
])
  assert(entries.includes(required), required);
await run(executable, [], {
  SystemRoot: process.env.SystemRoot,
  PATH: process.env.PATH,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
  STUDYAPP_METADATA_SMOKE_ROOT: root,
});
const result = JSON.parse(await readFile(join(root, 'result.json'), 'utf8')) as {
  electron: string;
  node: string;
  results: unknown[];
};
assert.equal(result.electron, '44.1.0');
assert.equal(result.results.length, fixtures.length);
assert.deepEqual(result.results[0], { kind: 'audio', durationSeconds: 1, assurance: 'structural' });
assert.deepEqual(result.results[1], result.results[0]);
assert.deepEqual(result.results[2], { kind: 'pdf', pageCount: 10 });
assert.deepEqual(result.results[3], {
  kind: 'presentation',
  slideParts: ['ppt/slides/slide9.xml', 'ppt/slides/slide2.xml'],
});
assert.deepEqual(result.results[5], {
  kind: 'audio',
  durationSeconds: 2304 / 44100,
  assurance: 'structural',
});
assert.deepEqual(result.results[6], {
  kind: 'image',
  encodedWidth: 30,
  encodedHeight: 20,
  displayWidth: 20,
  displayHeight: 30,
  orientation: 6,
  coordinateFrame: 'display-pixel-edges',
});
assert.deepEqual(result.results[7], {
  kind: 'text',
  lineCount: 2,
  normalizedCodeUnits: 4,
  normalization: 'utf8-bom-crlf-v1',
});
assert.deepEqual(result.results[8], { kind: 'pdf', pageCount: 4 });
assert.deepEqual(result.results[9], { error: 'METADATA_INVALID' });
assert.deepEqual(result.results[10], { error: 'METADATA_INVALID' });
assert.deepEqual(result.results[11], {
  kind: 'image',
  encodedWidth: 30,
  encodedHeight: 20,
  displayWidth: 30,
  displayHeight: 20,
  orientation: 1,
  coordinateFrame: 'display-pixel-edges',
});
console.log(JSON.stringify({ root, ...result }));
