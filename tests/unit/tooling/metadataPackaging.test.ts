import { describe, expect, it } from 'vitest';
import config, { createPackagerConfig } from '../../../forge.config';

describe('metadata production packaging boundary', () => {
  it('normal config has no smoke identifier and excludes private/source/test/build trees', () => {
    expect(config.buildIdentifier).toBeUndefined();
    const ignore = createPackagerConfig().ignore;
    expect(typeof ignore).toBe('function');
    if (typeof ignore !== 'function') throw new Error('missing filter');
    for (const path of [
      '/src/main/index.ts',
      '/tests/fixtures/private.txt',
      '/.env',
      '/out/app.exe',
      '/coverage/x',
      '/.codex/config.toml',
    ])
      expect(ignore(path)).toBe(true);
    for (const path of [
      '/package.json',
      '/.vite/build/metadata-worker.mjs',
      '/node_modules/music-metadata/lib/index.js',
      '/node_modules/pdf-lib/cjs/index.js',
    ])
      expect(ignore(path)).toBe(false);
  });
});
