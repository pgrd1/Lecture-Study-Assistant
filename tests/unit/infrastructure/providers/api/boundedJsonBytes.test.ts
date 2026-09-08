import { Buffer } from 'node:buffer';
import { expect, it } from 'vitest';
import { countBoundedJsonBytes } from '../../../../../src/infrastructure/providers/api/boundedJsonBytes';
import type { JsonValue } from '../../../../../src/shared/contracts/provider';

it.each<JsonValue>([
  null,
  true,
  false,
  -0,
  1e30,
  'a"\\\b\t\n\f\r\u0000\u001f한글é😀\ud800\udc00\ud800x\udc00',
  { '한"\\😀\ud800': ['a', { b: false }, null] },
  [],
  {},
])('counts exact escaped JSON UTF-8 bytes for %j', (value) => {
  const exact = Buffer.byteLength(JSON.stringify(value));
  expect(countBoundedJsonBytes(value, exact)).toBe(exact);
  expect(() => countBoundedJsonBytes(value, exact - 1)).toThrow('PROVIDER_REQUEST_TOO_LARGE');
});

it('supports the HTTP client null-prototype array snapshots', () => {
  const value = ['a', 'b'];
  Object.setPrototypeOf(value, null);
  expect(countBoundedJsonBytes(value, 9)).toBe(9);
});
