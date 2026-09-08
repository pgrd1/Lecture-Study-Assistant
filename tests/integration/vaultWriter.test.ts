import {
  access,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256File } from '../../src/core/jobs/fingerprint';
import { VaultService } from '../../src/infrastructure/vault/vaultService';
import { VaultWriter } from '../../src/infrastructure/vault/vaultWriter';
import { AppError } from '../../src/shared/errors';
import { withTempDirectory } from '../testkit/tempDirectory';

const FIXED_DATE = new Date('2026-09-01T12:34:56.000Z');
const FIXED_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const writerOptions = () => ({
  clock: () => FIXED_DATE,
  idGenerator: () => FIXED_ID,
});

const SAFE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg"><defs><marker id="node"/></defs><path d="M0 0L1 1" marker-end="url(#node)"/><text>자료구조</text><use href="#node"/></svg>';
const ARTIFACTS = [
  {
    extension: 'base',
    write: 'writeBase',
    read: 'readBase',
    content: '\ufeffviews:\n  - type: table\n',
  },
  {
    extension: 'canvas',
    write: 'writeCanvas',
    read: 'readCanvas',
    content: '{ "nodes": [], "edges": [] }',
  },
  { extension: 'svg', write: 'writeSvg', read: 'readSvg', content: SAFE_SVG },
  { extension: 'json', write: 'writeJson', read: 'readJson', content: '{ "answer": "한글" }' },
] as const;

describe('safe Obsidian artifacts', () => {
  it.each(['write', 'read'] as const)('rejects excessive SVG nesting on %s', async (operation) => {
    await withTempDirectory(async (directory) => {
      const connection = await new VaultService().connect({
        path: join(directory, 'vault'),
        mode: 'create',
      });
      const writer = new VaultWriter(connection, writerOptions());
      const target = join(connection.managedRoot, 'map.svg');
      const content = `<svg>${'<g>'.repeat(128)}${'</g>'.repeat(128)}</svg>`;
      const bounded = `<svg>${'<g/>'.repeat(128)}${'<g>'.repeat(63)}${'</g>'.repeat(63)}</svg>`;
      await writer.writeSvg({ relativePath: 'bounded.svg', content: bounded });
      expect((await writer.readSvg('bounded.svg'))?.content).toBe(bounded);
      if (operation === 'write') {
        await writer.writeSvg({ relativePath: 'map.svg', content: SAFE_SVG });
        await expect(writer.writeSvg({ relativePath: 'map.svg', content })).rejects.toMatchObject({
          code: 'VAULT_WRITE_FAILED',
        });
        expect(await readFile(target, 'utf8')).toBe(SAFE_SVG);
        expect(await readdir(connection.managedRoot)).toEqual([
          'bounded.svg',
          'map.svg',
          '메인 학습 노트.md',
        ]);
      } else {
        await writeFile(target, content);
        await expect(writer.readSvg('map.svg')).rejects.toMatchObject({
          code: 'VAULT_WRITE_FAILED',
        });
        expect(await readFile(target, 'utf8')).toBe(content);
      }
    });
  });

  it.each(ARTIFACTS)(
    'publishes and reads literal .$extension content and preserves conflicts',
    async (artifact) => {
      await withTempDirectory(async (directory) => {
        const connection = await new VaultService().connect({
          path: join(directory, 'vault'),
          mode: 'create',
        });
        const writer = new VaultWriter(connection, writerOptions());
        const relativePath = `과목/자료구조/map.${artifact.extension}`;
        expect(await writer[artifact.read](relativePath)).toBeNull();
        const written = await writer[artifact.write]({ relativePath, content: artifact.content });
        const target = join(connection.managedRoot, ...relativePath.split('/'));
        expect(written).toMatchObject({
          kind: 'written',
          relativePath,
          sha256: await sha256File(target),
        });
        expect(await readFile(target, 'utf8')).toBe(artifact.content);
        expect(await writer[artifact.read](relativePath)).toEqual({
          relativePath,
          content: artifact.content,
          sha256: written.sha256,
        });
        const conflict = await writer[artifact.write]({
          relativePath,
          content: artifact.content,
          expectedBaseHash: '0'.repeat(64),
        });
        expect(conflict.relativePath).toBe(
          `과목/자료구조/map.conflict-20260901-123456.${artifact.extension}`,
        );
        expect(conflict).toMatchObject({ kind: 'conflict', preservedRelativePath: relativePath });
        expect(await readFile(target, 'utf8')).toBe(artifact.content);
        const growingReader = new VaultWriter(connection, {
          beforeArtifactRead: () => writeFile(target, `${artifact.content} `),
        });
        await expect(growingReader[artifact.read](relativePath)).rejects.toMatchObject({
          code: 'VAULT_WRITE_FAILED',
        });
      });
    },
  );

  it.each(ARTIFACTS)(
    'rejects noncanonical .$extension paths before creating directories',
    async (artifact) => {
      await withTempDirectory(async (directory) => {
        const connection = await new VaultService().connect({
          path: join(directory, 'vault'),
          mode: 'create',
        });
        const writer = new VaultWriter(connection, writerOptions());
        const extension = artifact.extension;
        const paths = [
          `../escape.${extension}`,
          `folder\\escape.${extension}`,
          `/escape.${extension}`,
          `C:/escape.${extension}`,
          `C:escape.${extension}`,
          `//server/share/file.${extension}`,
          `file:///C:/escape.${extension}`,
          `CON/file.${extension}`,
          `folder/NUL.${extension}`,
          `folder/./file.${extension}`,
          `folder//file.${extension}`,
          `folder /file.${extension}`,
          `folder./file.${extension}`,
          `folder\u0000/file.${extension}`,
          `folder\u0085/file.${extension}`,
          `folder\u202e/file.${extension}`,
          `folder\ud800/file.${extension}`,
          'folder/wrong.html',
          `folder/file.${extension.toUpperCase()}`,
          `folder/file.${extension}.${extension}`,
          `folder/file.html.${extension}`,
          `folder/file.${extension}.html`,
        ];
        for (const relativePath of paths) {
          await expect(
            writer[artifact.write]({ relativePath, content: artifact.content }),
          ).rejects.toMatchObject({ code: 'SAFE_PATH' });
          await expect(writer[artifact.read](relativePath)).rejects.toMatchObject({
            code: 'SAFE_PATH',
          });
        }
        expect(await readdir(connection.managedRoot)).toEqual(['메인 학습 노트.md']);
      });
    },
  );

  it.each(ARTIFACTS)(
    'rejects non-strict .$extension inputs and invalid UTF-8 reads',
    async (artifact) => {
      await withTempDirectory(async (directory) => {
        const connection = await new VaultService().connect({
          path: join(directory, 'vault'),
          mode: 'create',
        });
        const writer = new VaultWriter(connection, writerOptions());
        const relativePath = `artifact.${artifact.extension}`;
        for (const input of [
          { relativePath, content: artifact.content, extra: true },
          { relativePath, content: artifact.content, expectedBaseHash: 'bad' },
          { relativePath, content: '\u0000' },
          { relativePath, content: '\ud800' },
        ]) {
          await expect(writer[artifact.write](input)).rejects.toMatchObject({
            code: 'VAULT_WRITE_FAILED',
          });
        }
        expect(await readdir(connection.managedRoot)).toEqual(['메인 학습 노트.md']);
        await writeFile(join(connection.managedRoot, relativePath), Buffer.from([0xc3, 0x28]));
        await expect(writer[artifact.read](relativePath)).rejects.toMatchObject({
          code: 'VAULT_WRITE_FAILED',
        });
      });
    },
  );

  it.each(
    ARTIFACTS.filter(
      (artifact) => artifact.extension === 'json' || artifact.extension === 'canvas',
    ),
  )('validates .$extension before replacement and after user edits', async (artifact) => {
    await withTempDirectory(async (directory) => {
      const connection = await new VaultService().connect({
        path: join(directory, 'vault'),
        mode: 'create',
      });
      const writer = new VaultWriter(connection, writerOptions());
      const relativePath = `artifact.${artifact.extension}`;
      await writer[artifact.write]({ relativePath, content: artifact.content });
      for (const content of ['{broken', '{"x":undefined}', '{"x": NaN}', '{"x":1,}']) {
        await expect(writer[artifact.write]({ relativePath, content })).rejects.toMatchObject({
          code: 'VAULT_WRITE_FAILED',
        });
        expect(await readFile(join(connection.managedRoot, relativePath), 'utf8')).toBe(
          artifact.content,
        );
      }
      expect(
        (await readdir(connection.managedRoot)).filter((name) => name.startsWith('.studyapp')),
      ).toEqual([]);
      await writeFile(join(connection.managedRoot, relativePath), '{user edit');
      await expect(writer[artifact.read](relativePath)).rejects.toMatchObject({
        code: 'VAULT_WRITE_FAILED',
      });
    });
  });

  it.each([
    '<?xml version="1.0"?><svg/>',
    '<?custom instruction?><svg/>',
    '<!DOCTYPE svg [<!ENTITY x "unsafe">]><svg/>',
    '<svg><script>alert(1)</script></svg>',
    '<svg><SCRIPT/></svg>',
    '<svg><foreignObject><div/></foreignObject></svg>',
    '<svg onload="alert(1)"/>',
    "<svg ONCLICK = 'alert(1)'/>",
    '<svg onload=alert(1)/>',
    '<svg><use href="https://example.com/a.svg#x"/></svg>',
    '<svg><use href="//example.com/x"/></svg>',
    '<svg><use href="file:///C:/private"/></svg>',
    '<svg><use href="javascript:alert(1)"/></svg>',
    '<svg><use href="data:image/svg+xml,bad"/></svg>',
    '<svg><use href="HtTp://example.com"/></svg>',
    '<svg><use href="&#x68;ttps://example.com"/></svg>',
    '<svg><use href="java&#x9;script:bad"/></svg>',
    '<svg><use href="%68ttps://example.com"/></svg>',
    '<svg><use href="other.svg#x"/></svg>',
    '<svg><path fill="URL( https://example.com/x )"/></svg>',
    '<svg><path fill="url( &quot;//example.com/x&quot; )"/></svg>',
    '<svg><path style="fill: u\\72l(https://example.com/x)"/></svg>',
    '<svg><style>@import "https://example.com/x";</style></svg>',
    '<svg><animate attributeName="href" to="https://example.com"/></svg>',
    '<svg xmlns="http://www.w3.org/1999/xhtml"/>',
    '<html/>',
    '<svg><g></svg>',
  ])('rejects unsafe SVG %s on both write and read', async (content) => {
    await withTempDirectory(async (directory) => {
      const connection = await new VaultService().connect({
        path: join(directory, 'vault'),
        mode: 'create',
      });
      const writer = new VaultWriter(connection, writerOptions());
      await writer.writeSvg({ relativePath: 'map.svg', content: SAFE_SVG });
      await expect(writer.writeSvg({ relativePath: 'map.svg', content })).rejects.toMatchObject({
        code: 'VAULT_WRITE_FAILED',
      });
      expect(await readFile(join(connection.managedRoot, 'map.svg'), 'utf8')).toBe(SAFE_SVG);
      await writeFile(join(connection.managedRoot, 'map.svg'), content);
      await expect(writer.readSvg('map.svg')).rejects.toMatchObject({ code: 'VAULT_WRITE_FAILED' });
    });
  });

  it('enforces exact UTF-8 boundaries for the 16 MiB and 32 MiB classes', async () => {
    await withTempDirectory(async (directory) => {
      const connection = await new VaultService().connect({
        path: join(directory, 'vault'),
        mode: 'create',
      });
      const writer = new VaultWriter(connection, writerOptions());
      const sixteen = 16 * 1024 * 1024;
      const base = `한${'a'.repeat(sixteen - 3)}`;
      await writer.writeBase({ relativePath: 'limit.base', content: base });
      expect((await writer.readBase('limit.base'))?.content).toBe(base);
      await expect(
        writer.writeBase({ relativePath: 'limit.base', content: `${base}a` }),
      ).rejects.toMatchObject({ code: 'VAULT_WRITE_FAILED' });
      await writer.writeMarkdown({ relativePath: 'limit.md', content: base });
      await expect(
        writer.writeMarkdown({ relativePath: 'limit.md', content: `${base}a` }),
      ).rejects.toMatchObject({ code: 'VAULT_WRITE_FAILED' });
      const json = `"${'a'.repeat(sixteen - 2)}"`;
      await writer.writeJson({ relativePath: 'limit.json', content: json });
      await writer.writeCanvas({ relativePath: 'limit.canvas', content: json });
      await expect(
        writer.writeJson({ relativePath: 'limit.json', content: `${json} ` }),
      ).rejects.toMatchObject({ code: 'VAULT_WRITE_FAILED' });
      await expect(
        writer.writeCanvas({ relativePath: 'limit.canvas', content: `${json} ` }),
      ).rejects.toMatchObject({ code: 'VAULT_WRITE_FAILED' });
      const svg = `<svg><text>${'a'.repeat(32 * 1024 * 1024 - 24)}</text></svg>`;
      expect(Buffer.byteLength(svg)).toBe(32 * 1024 * 1024);
      await writer.writeSvg({ relativePath: 'limit.svg', content: svg });
      expect((await writer.readSvg('limit.svg'))?.content).toBe(svg);
      await expect(
        writer.writeSvg({ relativePath: 'limit.svg', content: `${svg} ` }),
      ).rejects.toMatchObject({ code: 'VAULT_WRITE_FAILED' });
      await writeFile(join(connection.managedRoot, 'limit.base'), `${base}a`);
      await expect(writer.readBase('limit.base')).rejects.toBeDefined();
    });
  }, 30_000);

  it('restores a Canvas replacement and retains a non-enumerable recovery token', async () => {
    await withTempDirectory(async (directory) => {
      const connection = await new VaultService().connect({
        path: join(directory, 'vault'),
        mode: 'create',
      });
      await new VaultWriter(connection, writerOptions()).writeCanvas({
        relativePath: 'map.canvas',
        content: '{"nodes":[]}',
      });
      const writer = new VaultWriter(connection, {
        ...writerOptions(),
        beforeMutation: ({ kind }) => {
          if (kind === 'rename-temp-to-target') throw new Error('simulated failure');
        },
      });
      const error = await writer
        .writeCanvas({ relativePath: 'map.canvas', content: '{"nodes":[1]}' })
        .catch((failure: unknown) => failure);
      expect(error).toMatchObject({ code: 'VAULT_WRITE_FAILED' });
      expect(Object.keys(error as object)).not.toContain('recoveryToken');
      const token = (error as AppError).recoveryToken ?? '';
      expect(token).toBe(`.studyapp-${FIXED_ID}.tmp`);
      expect(await readFile(join(connection.managedRoot, 'map.canvas'), 'utf8')).toBe(
        '{"nodes":[]}',
      );
      expect(await readFile(join(connection.managedRoot, token), 'utf8')).toBe('{"nodes":[1]}');
    });
  });

  it('rechecks a junction swapped in before a Canvas staging write', async () => {
    await withTempDirectory(async (directory) => {
      const connection = await new VaultService().connect({
        path: join(directory, 'vault'),
        mode: 'create',
      });
      const outside = join(directory, 'outside');
      const parent = join(connection.managedRoot, 'course');
      const displaced = join(connection.managedRoot, 'original');
      await mkdir(outside);
      let swapped = false;
      const writer = new VaultWriter(connection, {
        ...writerOptions(),
        beforeMutation: async ({ kind }) => {
          if (kind === 'open-temp' && !swapped) {
            swapped = true;
            await rename(parent, displaced);
            await symlink(outside, parent, 'junction');
          }
        },
      });
      try {
        await expect(
          writer.writeCanvas({ relativePath: 'course/map.canvas', content: '{}' }),
        ).rejects.toMatchObject({ code: 'SAFE_PATH' });
        expect(await readdir(outside)).toEqual([]);
      } finally {
        if (swapped) {
          await unlink(parent);
          await rename(displaced, parent);
        }
      }
    });
  });
});

describe('Obsidian Vault writer', () => {
  it('creates an Obsidian Vault, managed root, and main note', async () => {
    await withTempDirectory(async (directory) => {
      const vaultRoot = join(directory, 'Study Vault');
      const connection = await new VaultService().connect({ path: vaultRoot, mode: 'create' });

      expect(connection.vaultRoot).toBe(vaultRoot);
      expect(connection.managedRoot).toBe(join(vaultRoot, 'AI 학습'));
      expect(await readdir(join(vaultRoot, '.obsidian'))).toEqual([]);
      expect(await readFile(join(connection.managedRoot, '메인 학습 노트.md'), 'utf8')).toContain(
        '# 메인 학습 노트',
      );
      expect(Object.isFrozen(connection)).toBe(true);
    });
  });

  it('connects only to valid existing Vaults and rejects non-empty create targets', async () => {
    await withTempDirectory(async (directory) => {
      const validVault = join(directory, 'valid');
      const invalidVault = join(directory, 'invalid');
      const nonEmptyTarget = join(directory, 'non-empty');
      await mkdir(join(validVault, '.obsidian'), { recursive: true });
      await mkdir(invalidVault);
      await mkdir(nonEmptyTarget);
      await writeFile(join(nonEmptyTarget, 'private.txt'), 'keep');

      await expect(
        new VaultService().connect({ path: validVault, mode: 'existing' }),
      ).resolves.toMatchObject({ vaultRoot: validVault });
      await expect(
        new VaultService().connect({ path: invalidVault, mode: 'existing' }),
      ).rejects.toMatchObject({ code: 'VAULT_CONNECTION_FAILED' });
      await expect(
        new VaultService().connect({ path: nonEmptyTarget, mode: 'create' }),
      ).rejects.toMatchObject({ code: 'VAULT_CONNECTION_FAILED' });
      expect(await readFile(join(nonEmptyTarget, 'private.txt'), 'utf8')).toBe('keep');
    });
  });

  it('never writes outside the managed root', async () => {
    await withTempDirectory(async (directory) => {
      const connection = await new VaultService().connect({
        path: join(directory, 'vault'),
        mode: 'create',
      });
      const writer = new VaultWriter(connection, writerOptions());

      await expect(
        writer.writeMarkdown({ relativePath: '../private.md', content: 'x' }),
      ).rejects.toMatchObject({ code: 'SAFE_PATH' });
      await expect(
        writer.writeMarkdown({ relativePath: 'C:\\private.md', content: 'x' }),
      ).rejects.toMatchObject({ code: 'SAFE_PATH' });
      await expect(access(join(directory, 'private.md'))).rejects.toBeDefined();
    });
  });

  it('preserves a user-edited note and writes a timestamped conflict note', async () => {
    await withTempDirectory(async (directory) => {
      const connection = await new VaultService().connect({
        path: join(directory, 'vault'),
        mode: 'create',
      });
      const writer = new VaultWriter(connection, writerOptions());
      const relativePath = '과목/자료구조/자료구조.md';
      const target = join(connection.managedRoot, '과목', '자료구조', '자료구조.md');

      const initial = await writer.writeMarkdown({ relativePath, content: 'base' });
      const baseHash = await sha256File(target);
      await writeFile(target, 'user edit');
      const result = await writer.writeMarkdown({
        relativePath,
        content: 'generated',
        expectedBaseHash: baseHash,
      });

      expect(initial).toMatchObject({ kind: 'written', relativePath });
      expect(result).toEqual({
        kind: 'conflict',
        relativePath: '과목/자료구조/자료구조.conflict-20260901-123456.md',
        preservedRelativePath: relativePath,
        sha256: await sha256File(
          join(connection.managedRoot, '과목', '자료구조', '자료구조.conflict-20260901-123456.md'),
        ),
        temporaryRecoveryToken: null,
        backupRecoveryToken: null,
      });
      expect(await readFile(target, 'utf8')).toBe('user edit');
      expect(
        await readFile(
          join(connection.managedRoot, '과목', '자료구조', '자료구조.conflict-20260901-123456.md'),
          'utf8',
        ),
      ).toBe('generated');
    });
  });

  it('bounds markdown reads even when the file grows after its size check', async () => {
    await withTempDirectory(async (directory) => {
      const connection = await new VaultService().connect({
        path: join(directory, 'vault'),
        mode: 'create',
      });
      const relativePath = '과목/보안/보안.md';
      const target = join(connection.managedRoot, ...relativePath.split('/'));
      await new VaultWriter(connection, writerOptions()).writeMarkdown({
        relativePath,
        content: '작은 노트',
      });
      let hookCalls = 0;
      const writer = new VaultWriter(connection, {
        ...writerOptions(),
        maxMarkdownBytes: 32,
        beforeMarkdownRead: async () => {
          hookCalls += 1;
          await writeFile(target, '커진 노트'.repeat(100), 'utf8');
        },
      });

      await expect(writer.readMarkdown(relativePath)).rejects.toMatchObject({
        code: 'VAULT_WRITE_FAILED',
      });
      expect(hookCalls).toBe(1);
    });
  });

  it('preserves a user deletion by writing regenerated content as a conflict note', async () => {
    await withTempDirectory(async (directory) => {
      const connection = await new VaultService().connect({
        path: join(directory, 'vault'),
        mode: 'create',
      });
      const writer = new VaultWriter(connection, writerOptions());
      const relativePath = '과목/자료구조/자료구조.md';
      const target = join(connection.managedRoot, ...relativePath.split('/'));
      await writer.writeMarkdown({ relativePath, content: 'base' });
      const baseHash = await sha256File(target);
      await unlink(target);

      const result = await writer.writeMarkdown({
        relativePath,
        content: 'regenerated',
        expectedBaseHash: baseHash,
      });

      expect(result.kind).toBe('conflict');
      expect(result.relativePath).toBe('과목/자료구조/자료구조.conflict-20260901-123456.md');
      await expect(access(target)).rejects.toBeDefined();
    });
  });

  it('rechecks the base hash immediately before rename and preserves a late user edit', async () => {
    await withTempDirectory(async (directory) => {
      const connection = await new VaultService().connect({
        path: join(directory, 'vault'),
        mode: 'create',
      });
      const relativePath = '과목/자료구조/자료구조.md';
      const target = join(connection.managedRoot, ...relativePath.split('/'));
      await new VaultWriter(connection, writerOptions()).writeMarkdown({
        relativePath,
        content: 'base',
      });
      const baseHash = await sha256File(target);
      let edited = false;
      const writer = new VaultWriter(connection, {
        ...writerOptions(),
        beforeMutation: async ({ kind }) => {
          if (kind === 'rename-target-to-backup' && !edited) {
            edited = true;
            await writeFile(target, 'late user edit');
          }
        },
      });

      const result = await writer.writeMarkdown({
        relativePath,
        content: 'generated',
        expectedBaseHash: baseHash,
      });

      expect(result.kind).toBe('conflict');
      expect(await readFile(target, 'utf8')).toBe('late user edit');
      expect(
        await readFile(join(connection.managedRoot, ...result.relativePath.split('/')), 'utf8'),
      ).toBe('generated');
    });
  });

  it('copies and verifies an attachment without deleting its source', async () => {
    await withTempDirectory(async (directory) => {
      const source = join(directory, 'lecture.m4a');
      await writeFile(source, Buffer.from('audio bytes'));
      const expectedSha256 = await sha256File(source);
      const connection = await new VaultService().connect({
        path: join(directory, 'vault'),
        mode: 'create',
      });
      const writer = new VaultWriter(connection, writerOptions());
      const relativePath = '과목/자료구조/자료/음성/lecture.m4a';

      await expect(
        writer.copyAttachment({ sourcePath: source, relativePath, expectedSha256 }),
      ).resolves.toBe(relativePath);
      expect(await sha256File(join(connection.managedRoot, ...relativePath.split('/')))).toBe(
        expectedSha256,
      );
      expect(await readFile(source)).toEqual(Buffer.from('audio bytes'));
      await expect(
        writer.copyAttachment({ sourcePath: source, relativePath, expectedSha256 }),
      ).resolves.toBe(relativePath);

      const target = join(connection.managedRoot, ...relativePath.split('/'));
      await writeFile(target, 'user replacement');
      const conflictPath = await writer.copyAttachment({
        sourcePath: source,
        relativePath,
        expectedSha256,
      });
      expect(conflictPath).toBe('과목/자료구조/자료/음성/lecture.conflict-20260901-123456.m4a');
      expect(await readFile(target, 'utf8')).toBe('user replacement');
      expect(await sha256File(join(connection.managedRoot, ...conflictPath.split('/')))).toBe(
        expectedSha256,
      );
    });
  });

  it('does not publish an attachment whose copied hash differs', async () => {
    await withTempDirectory(async (directory) => {
      const source = join(directory, 'lecture.m4a');
      await writeFile(source, 'audio bytes');
      const connection = await new VaultService().connect({
        path: join(directory, 'vault'),
        mode: 'create',
      });
      const writer = new VaultWriter(connection, writerOptions());
      const relativePath = '과목/자료구조/자료/음성/lecture.m4a';

      await expect(
        writer.copyAttachment({
          sourcePath: source,
          relativePath,
          expectedSha256: '0'.repeat(64),
        }),
      ).rejects.toMatchObject({ code: 'ATTACHMENT_HASH_MISMATCH' });
      await expect(
        access(join(connection.managedRoot, ...relativePath.split('/'))),
      ).rejects.toBeDefined();
      expect(await readFile(source, 'utf8')).toBe('audio bytes');
    });
  });

  it('rejects a different attachment source opened after validation before copying bytes', async () => {
    await withTempDirectory(async (directory) => {
      const source = join(directory, 'lecture.m4a');
      const displaced = join(directory, 'lecture-original.m4a');
      const outside = join(directory, 'outside.m4a');
      await writeFile(source, 'trusted-data');
      await writeFile(outside, 'outside-data');
      const expectedSha256 = await sha256File(source);
      const connection = await new VaultService().connect({
        path: join(directory, 'vault'),
        mode: 'create',
      });
      let sourceReads = 0;
      const writer = new VaultWriter(connection, {
        ...writerOptions(),
        openAttachmentSource: async (path) => {
          await rename(path, displaced);
          await rename(outside, path);
          const substituted = await open(path, 'r');
          await rename(path, outside);
          await rename(displaced, path);
          return Object.freeze({
            close: () => substituted.close(),
            read: (buffer: Buffer, offset: number, length: number, position: number) => {
              sourceReads += 1;
              return substituted.read(buffer, offset, length, position);
            },
            stat: () => substituted.stat(),
          });
        },
      });
      const relativePath = '과목/자료구조/자료/음성/lecture.m4a';
      const targetDirectory = join(connection.managedRoot, '과목', '자료구조', '자료', '음성');

      await expect(
        writer.copyAttachment({ sourcePath: source, relativePath, expectedSha256 }),
      ).rejects.toMatchObject({ code: 'SOURCE_COPY_FAILED' });

      expect(sourceReads).toBe(0);
      const stagedEntries = await readdir(targetDirectory);
      expect(stagedEntries).toEqual([`.studyapp-${FIXED_ID}.tmp`]);
      expect(await readFile(join(targetDirectory, stagedEntries[0] ?? ''))).toEqual(
        Buffer.alloc(0),
      );
      expect(await readFile(source, 'utf8')).toBe('trusted-data');
      expect(await readFile(outside, 'utf8')).toBe('outside-data');
    });
  });

  it('restores the original target when replacement fails after backup', async () => {
    await withTempDirectory(async (directory) => {
      const connection = await new VaultService().connect({
        path: join(directory, 'vault'),
        mode: 'create',
      });
      const relativePath = '과목/자료구조/자료구조.md';
      const target = join(connection.managedRoot, ...relativePath.split('/'));
      await new VaultWriter(connection, writerOptions()).writeMarkdown({
        relativePath,
        content: 'original',
      });
      const writer = new VaultWriter(connection, {
        ...writerOptions(),
        beforeMutation: ({ kind }) => {
          if (kind === 'rename-temp-to-target') {
            throw new Error('simulated replacement failure');
          }
        },
      });

      let captured: unknown;
      try {
        await writer.writeMarkdown({ relativePath, content: 'replacement' });
      } catch (error) {
        captured = error;
      }

      expect(captured).toBeInstanceOf(AppError);
      expect(captured).toMatchObject({ code: 'VAULT_WRITE_FAILED' });
      expect((captured as AppError).recoveryToken).toMatch(/^\.studyapp-[a-f0-9-]+\.tmp$/u);
      expect(Object.keys(captured as object)).not.toContain('recoveryToken');
      expect(await readFile(target, 'utf8')).toBe('original');
      expect(await readdir(join(connection.managedRoot, '과목', '자료구조'))).toContain(
        (captured as AppError).recoveryToken,
      );
    });
  });

  it('reports both recovery tokens when a concurrent target prevents backup restore', async () => {
    await withTempDirectory(async (directory) => {
      const connection = await new VaultService().connect({
        path: join(directory, 'vault'),
        mode: 'create',
      });
      const relativePath = '과목/자료구조/자료구조.md';
      const target = join(connection.managedRoot, ...relativePath.split('/'));
      await new VaultWriter(connection, writerOptions()).writeMarkdown({
        relativePath,
        content: 'original',
      });
      const writer = new VaultWriter(connection, {
        ...writerOptions(),
        beforeMutation: async ({ kind }) => {
          if (kind === 'rename-temp-to-target') {
            await writeFile(target, 'concurrent file');
          }
        },
      });

      let captured: unknown;
      try {
        await writer.writeMarkdown({ relativePath, content: 'replacement' });
      } catch (error) {
        captured = error;
      }
      const recoveryError = captured as AppError & { readonly backupRecoveryToken?: string };

      expect(recoveryError.recoveryToken).toMatch(/^\.studyapp-[a-f0-9-]+\.tmp$/u);
      expect(recoveryError.backupRecoveryToken).toMatch(
        /^\.studyapp-backup-[0-9]{8}-[0-9]{6}-[a-f0-9-]+\.bak$/u,
      );
      expect(Object.keys(recoveryError)).not.toContain('backupRecoveryToken');
      expect(await readFile(target, 'utf8')).toBe('concurrent file');
      expect(
        await readFile(
          join(connection.managedRoot, '과목', '자료구조', recoveryError.backupRecoveryToken ?? ''),
          'utf8',
        ),
      ).toBe('original');
    });
  });

  it('rechecks for a junction swapped in immediately before opening the temp file', async () => {
    await withTempDirectory(async (directory) => {
      const connection = await new VaultService().connect({
        path: join(directory, 'vault'),
        mode: 'create',
      });
      const outside = join(directory, 'outside');
      const courseParent = join(connection.managedRoot, '과목', '자료구조');
      const displaced = join(connection.managedRoot, '과목', '자료구조-original');
      await mkdir(outside);
      let swapped = false;
      const writer = new VaultWriter(connection, {
        ...writerOptions(),
        beforeMutation: async ({ kind }) => {
          if (kind === 'open-temp' && !swapped) {
            swapped = true;
            await rename(courseParent, displaced);
            await symlink(outside, courseParent, 'junction');
          }
        },
      });

      await expect(
        writer.writeMarkdown({
          relativePath: '과목/자료구조/자료구조.md',
          content: 'must stay managed',
        }),
      ).rejects.toMatchObject({ code: 'SAFE_PATH' });
      await expect(access(join(outside, '자료구조.md'))).rejects.toBeDefined();

      await unlink(courseParent);
      await rename(displaced, courseParent);
    });
  });
});
