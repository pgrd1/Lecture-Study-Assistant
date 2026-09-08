import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createBoundedNodeProcessRunner } from '../../../../src/infrastructure/providers/cli/boundedNodeProcessRunner';
import { createWindowsPrivateDirectoryAcl } from '../../../../src/infrastructure/providers/cli/cliPrivateDirectories';
import {
  createNodeCliExecutableFileAccess,
  createNodeCliFileHasher,
} from '../../../../src/infrastructure/providers/cli/nodeCliFileIntegrity';
import { ProviderSourceMaterializer } from '../../../../src/infrastructure/providers/providerSourceMaterializer';

it('verifies the real Windows current-user/SYSTEM ACL before any source child exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'provider-owned-acl-test-'));
  const bytes = Buffer.from('synthetic fixture');
  const source = join(root, 'original.jpg');
  const acl = createWindowsPrivateDirectoryAcl({
    runner: createBoundedNodeProcessRunner(),
    files: createNodeCliExecutableFileAccess(),
    hasher: createNodeCliFileHasher(),
  });
  let verified = false;
  let securedPath = '';
  const materializer = new ProviderSourceMaterializer(root, {
    acl: {
      secure: async (path, operation) => {
        expect(path.startsWith(join(root, 'request-'))).toBe(true);
        expect(await readdir(path)).toEqual([]);
        await acl.secure(path, operation); // helper reads back protected ACL, owner and exact SID/full-control entries
        expect(await readdir(path)).toEqual([]);
        verified = true;
        securedPath = path;
      },
    },
  });
  try {
    await writeFile(source, bytes);
    const id = randomUUID();
    const result = await materializer.materialize(id, [
      {
        role: 'user',
        kind: 'source_file',
        sourceId: randomUUID(),
        filePath: source,
        sizeBytes: bytes.length,
        mediaType: 'image',
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    ]);
    expect(verified).toBe(true);
    expect(result.workspacePath).toBe(securedPath);
    const copied = result.files[0];
    if (!copied) throw new Error('missing fixture');
    expect(await readFile(copied.absolutePath)).toEqual(bytes);
    await materializer.cleanup(id);
    expect(await readdir(root)).toEqual(['original.jpg']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
