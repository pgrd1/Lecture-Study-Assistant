import { readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { connect, Socket } from 'node:net';
import { parentPort } from 'node:worker_threads';
import { sealParserAccess } from '../../../src/infrastructure/metadata/parserGuard.ts';

sealParserAccess();
const probes = [
  () => readFileSync('never-opened'),
  () => writeFileSync('never-written', 'x'),
  () => request('https://invalid.test'),
  () => connect(443, 'invalid.test'),
  () => new Socket().connect(443, 'invalid.test'),
  () => fetch('https://invalid.test'),
];
for (const probe of probes) {
  let denied = false;
  try {
    probe();
  } catch (error) {
    denied = error.message === 'METADATA_ACCESS_DENIED';
  }
  if (!denied) throw new Error('GUARD_FAILED');
}
parentPort.postMessage(
  JSON.stringify({
    kind: 'text',
    lineCount: probes.length,
    normalizedCodeUnits: 1,
    normalization: 'utf8-bom-crlf-v1',
  }),
);
