import { describe, expect, it } from 'vitest';
import { fixtureFile } from '../../testkit/tempDirectory';

describe('temporary-directory test helpers', () => {
  it('rejects nested fixture names before writing outside the fixture root', async () => {
    await expect(fixtureFile('nested/escape.txt', 'unsafe')).rejects.toThrow('SAFE_TEST_PATH');
  });
});
