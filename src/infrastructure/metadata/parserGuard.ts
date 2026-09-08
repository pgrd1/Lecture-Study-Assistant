import { createRequire, syncBuiltinESMExports } from 'node:module';

/** Defense in depth inside the worker, not a security sandbox for exploited native code. */
export const sealParserAccess = (): void => {
  const deny = (): never => {
    throw new TypeError('METADATA_ACCESS_DENIED');
  };
  const require = createRequire(import.meta.url);
  for (const [module, names] of Object.entries({
    'node:http': ['request', 'get'],
    'node:https': ['request', 'get'],
    'node:http2': ['connect', 'createServer', 'createSecureServer'],
    'node:net': ['connect', 'createConnection', 'createServer'],
    'node:tls': ['connect', 'createServer'],
    'node:dgram': ['createSocket'],
    'node:dns': ['lookup', 'resolve'],
    'node:dns/promises': ['lookup', 'resolve'],
    'node:child_process': [
      'spawn',
      'exec',
      'execFile',
      'fork',
      'spawnSync',
      'execSync',
      'execFileSync',
    ],
    'node:fs': [
      'open',
      'openSync',
      'readFile',
      'readFileSync',
      'createReadStream',
      'writeFile',
      'writeFileSync',
      'appendFile',
      'appendFileSync',
      'createWriteStream',
      'unlink',
      'unlinkSync',
      'rename',
      'renameSync',
      'rm',
      'rmSync',
    ],
    'node:fs/promises': ['open', 'readFile', 'writeFile', 'appendFile', 'unlink', 'rename', 'rm'],
  })) {
    const api = require(module) as Record<string, unknown>;
    for (const name of names) api[name] = deny;
  }
  const net = require('node:net') as { Socket: { prototype: { connect: unknown } } };
  net.Socket.prototype.connect = deny;
  syncBuiltinESMExports();
  Object.assign(globalThis, { fetch: deny, WebSocket: deny, XMLHttpRequest: deny });
};
