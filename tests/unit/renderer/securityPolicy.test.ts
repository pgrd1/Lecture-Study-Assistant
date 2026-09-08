import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('renderer content security policy', () => {
  it('does not allow arbitrary localhost connections in packaged HTML', () => {
    const html = readFileSync(resolve(process.cwd(), 'src/renderer/index.html'), 'utf8');

    expect(html).toContain("connect-src 'self';");
    expect(html).not.toMatch(/(?:https?|wss?):\/\/localhost/);
  });
});
