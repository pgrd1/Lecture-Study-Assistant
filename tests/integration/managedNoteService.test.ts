import { createHash } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ManagedNoteService } from '../../src/application/obsidian/managedNoteService';
import {
  createRepositories,
  openDatabase,
  type SqliteDatabase,
} from '../../src/infrastructure/db/sqliteDatabase';
import { VaultService } from '../../src/infrastructure/vault/vaultService';
import { VaultWriter } from '../../src/infrastructure/vault/vaultWriter';
import {
  parseManagedNotePublication,
  parseManagedNoteRevision,
} from '../../src/shared/contracts/managedNoteRevision';
import { withTempDirectory } from '../testkit/tempDirectory';

const NOW = '2026-09-07T01:02:03.000Z';
const BASE =
  '---\n"locked": false\n---\n\n<!-- study-assistant:generated:start section="summary" revision="r1" -->\nOld\n<!-- study-assistant:generated:end -->\n\n<!-- study-assistant:user:start -->\nnotes\n<!-- study-assistant:user:end -->\n';
const NEXT = BASE.replace('Old', 'New').replace('revision="r1"', 'revision="r2"');
const hash = (content: string) => createHash('sha256').update(content).digest('hex');
const publication = (content = BASE) =>
  Object.freeze({ stableId: 'note_a', relativePath: 'note.md', content, generationRevision: 'r1' });
const revision = (content = BASE) =>
  Object.freeze({
    stableId: 'note_a',
    relativePath: 'note.md',
    pathKey: 'note.md',
    generatedBase: content,
    generatedBaseHash: hash(content),
    publishedHash: hash(content),
    generationRevision: 'r1',
    revision: 0,
    decision: 'written' as const,
    createdAt: NOW,
    updatedAt: NOW,
  });

describe('managed note publication with real SQLite and VaultWriter', () => {
  it('reserves the complete double-digit collision suffix at the 1024-unit path boundary', async () => {
    await withTempDirectory(async (directory) => {
      let database: SqliteDatabase | undefined;
      try {
        const connection = await new VaultService().connect({
          path: join(directory, 'vault'),
          mode: 'create',
        });
        const writer = new VaultWriter(connection, { clock: () => new Date(NOW) });
        database = openDatabase(join(directory, 'db.sqlite'));
        const repository = createRepositories(database).managedNotes;
        const service = new ManagedNoteService(repository, writer, () => new Date(NOW));
        const parent = `${(`${'a'.repeat(180)}/`).repeat(5)}${'b'.repeat(22)}/`;
        const originalPath = `${parent}${'n'.repeat(55)}.md`;
        const expected = `${parent}nnnnnnnnn-AI-충돌-20260907T010203000Z-rrrrrrrrrrrrrrrr-c3bbab5f152a.md`;
        const expectedCollision = `${parent}nnnnnnnnn-AI-충돌-20260907T010203000Z-rrrrrrrrrrrrrrrr-c3bbab5f152a.conflict-20260907-010203-10.md`;
        await writer.writeMarkdown({
          relativePath: originalPath,
          content: 'personal bytes',
          expectedBaseHash: null,
        });
        const input = {
          ...publication(NEXT),
          relativePath: originalPath,
          generationRevision: 'r'.repeat(80),
        };
        const first = await service.publish(input);
        if (first.kind !== 'conflict_preserved') throw new Error('EXPECTED_CONFLICT');
        // Occupy the actual writer alternatives so the next publication must reach -10.
        const occupied = Array.from(
          { length: 9 },
          (_, index) =>
            `${first.candidatePath.slice(0, -3)}.conflict-20260907-010203${index === 0 ? '' : `-${index + 1}`}.md`,
        );
        for (const relativePath of occupied) {
          await writer.writeMarkdown({
            relativePath,
            content: 'prior conflict bytes',
            expectedBaseHash: null,
          });
        }
        const second = await service.publish({ ...input, content: BASE });
        expect(first).toEqual({
          kind: 'conflict_preserved',
          currentPath: originalPath,
          candidatePath: expected,
        });
        expect(second).toEqual({
          kind: 'conflict_preserved',
          currentPath: originalPath,
          candidatePath: expectedCollision,
        });
        expect(expected.length).toBe(996);
        expect(expectedCollision.length).toBe(1024);
        expect(Math.max(...expectedCollision.split('/').map((segment) => segment.length))).toBe(
          180,
        );
        expect((await writer.readMarkdown(expected))?.content).toBe(NEXT);
        expect((await writer.readMarkdown(expectedCollision))?.content).toBe(BASE);
        expect((await writer.readMarkdown(originalPath))?.content).toBe('personal bytes');
        for (const path of occupied)
          expect((await writer.readMarkdown(path))?.content).toBe('prior conflict bytes');
        expect(repository.get('note_a')).toBeNull();
        database.close();
        database = openDatabase(join(directory, 'db.sqlite'));
        expect(
          createRepositories(database)
            .managedNotes.conflicts('note_a')
            .map((row) => row.candidatePath),
        ).toEqual([expected, expectedCollision]);
      } finally {
        database?.close();
      }
    });
  });

  it('retains untouched user bytes in the published file while accepting the full generated candidate base', async () => {
    await withTempDirectory(async (directory) => {
      let database: SqliteDatabase | undefined;
      try {
        const connection = await new VaultService().connect({
          path: join(directory, 'vault'),
          mode: 'create',
        });
        database = openDatabase(join(directory, 'db.sqlite'));
        const repository = createRepositories(database).managedNotes;
        const service = new ManagedNoteService(
          repository,
          new VaultWriter(connection),
          () => new Date(NOW),
        );
        await service.publish(publication());
        const candidate = NEXT.replace('\nnotes\n', '\nnew default\n');
        expect(await service.publish(publication(candidate))).toEqual({
          kind: 'written',
          sha256: hash(NEXT),
        });
        expect(await readFile(join(connection.managedRoot, 'note.md'), 'utf8')).toBe(NEXT);
        expect(repository.get('note_a')).toMatchObject({
          generatedBase: candidate,
          generatedBaseHash: hash(candidate),
          publishedHash: hash(NEXT),
          revision: 1,
        });
        database.close();
        database = openDatabase(join(directory, 'db.sqlite'));
        expect(createRepositories(database).managedNotes.get('note_a')).toMatchObject({
          generatedBase: candidate,
          publishedHash: hash(NEXT),
        });
      } finally {
        database?.close();
      }
    });
  });

  it.each([
    {
      path: `${'😀'.repeat(40)}.md`,
      expected: `${'😀'.repeat(20)}-AI-충돌-20260907T010203000Z-rrrrrrrrrrrrrrrr-2bb06e2be9c6.md`,
    },
    {
      path: `${(`${'a'.repeat(160)}/`).repeat(6)}${'n'.repeat(55)}.md`,
      expected: `${(`${'a'.repeat(160)}/`).repeat(5)}${'n'.repeat(40)}-AI-충돌-20260907T010203000Z-rrrrrrrrrrrrrrrr-bc93d320c9d6.md`,
    },
  ])('bounds conflict names for UTF-16 and near-1024 paths: $path', async ({ path, expected }) => {
    await withTempDirectory(async (directory) => {
      let database: SqliteDatabase | undefined;
      try {
        const connection = await new VaultService().connect({
          path: join(directory, 'vault'),
          mode: 'create',
        });
        const writer = new VaultWriter(connection, { clock: () => new Date(NOW) });
        database = openDatabase(join(directory, 'db.sqlite'));
        await writer.writeMarkdown({
          relativePath: path,
          content: 'personal bytes',
          expectedBaseHash: null,
        });
        const repository = createRepositories(database).managedNotes;
        const service = new ManagedNoteService(repository, writer, () => new Date(NOW));
        const input = {
          ...publication(NEXT),
          relativePath: path,
          generationRevision: 'r'.repeat(80),
        };
        expect(await service.publish(input)).toEqual({
          kind: 'conflict_preserved',
          currentPath: path,
          candidatePath: expected,
        });
        const repeated = `${expected.slice(0, -3)}.conflict-20260907-010203.md`;
        expect(await service.publish({ ...input, content: BASE })).toEqual({
          kind: 'conflict_preserved',
          currentPath: path,
          candidatePath: repeated,
        });
        expect((await writer.readMarkdown(path))?.content).toBe('personal bytes');
        expect((await writer.readMarkdown(expected))?.content).toBe(NEXT);
        expect((await writer.readMarkdown(repeated))?.content).toBe(BASE);
        for (const candidatePath of [expected, repeated]) {
          expect(candidatePath.length).toBeLessThanOrEqual(1024);
          expect(candidatePath.split('/').at(-1)?.length).toBeLessThanOrEqual(180);
        }
        expect(repository.get('note_a')).toBeNull();
        expect(repository.conflicts('note_a').map((row) => row.candidatePath)).toEqual([
          expected,
          repeated,
        ]);
      } finally {
        database?.close();
      }
    });
  });

  it('persists first write, reopens, preserves user bytes and keeps the prior path across a title change', async () => {
    await withTempDirectory(async (directory) => {
      let database: SqliteDatabase | undefined;
      try {
        const connection = await new VaultService().connect({
          path: join(directory, 'vault'),
          mode: 'create',
        });
        const writer = new VaultWriter(connection);
        database = openDatabase(join(directory, 'db.sqlite'));
        const service = new ManagedNoteService(
          createRepositories(database).managedNotes,
          writer,
          () => new Date(NOW),
        );
        expect(await service.publish(publication())).toEqual({
          kind: 'written',
          sha256: hash(BASE),
        });
        expect(createRepositories(database).managedNotes.get('note_a')).toEqual(revision());
        database.close();
        database = openDatabase(join(directory, 'db.sqlite'));
        const current = BASE.replace('\nnotes\n', '\r\nmy notes  \n\n');
        await writeFile(join(connection.managedRoot, 'note.md'), current);
        const reopened = createRepositories(database).managedNotes;
        const nextService = new ManagedNoteService(reopened, writer, () => new Date(NOW));
        const merged = NEXT.replace('\nnotes\n', '\r\nmy notes  \n\n');
        expect(
          await nextService.publish({ ...publication(NEXT), relativePath: 'new-title.md' }),
        ).toEqual({ kind: 'written', sha256: hash(merged) });
        expect(await readFile(join(connection.managedRoot, 'note.md'), 'utf8')).toBe(merged);
        expect(await writer.readMarkdown('new-title.md')).toBeNull();
        expect(reopened.get('note_a')).toMatchObject({
          generatedBase: NEXT,
          publishedHash: hash(merged),
          revision: 1,
          relativePath: 'note.md',
        });
        expect(await nextService.publish(publication(NEXT))).toEqual({
          kind: 'unchanged',
          sha256: hash(merged),
        });
        expect(reopened.history('note_a').map((row) => row.revision)).toEqual([0, 1, 2]);
      } finally {
        database?.close();
      }
    });
  });

  it.each(['untracked', 'deleted', 'locked', 'malformed', 'generated'] as const)(
    'preserves %s files and audits repeat conflicts without overwriting',
    async (mode) => {
      await withTempDirectory(async (directory) => {
        let database: SqliteDatabase | undefined;
        try {
          const connection = await new VaultService().connect({
            path: join(directory, 'vault'),
            mode: 'create',
          });
          const writer = new VaultWriter(connection, { clock: () => new Date(NOW) });
          database = openDatabase(join(directory, 'db.sqlite'));
          const repository = createRepositories(database).managedNotes;
          const service = new ManagedNoteService(repository, writer, () => new Date(NOW));
          if (mode !== 'untracked') await service.publish(publication());
          const current =
            mode === 'untracked'
              ? 'personal untracked text'
              : mode === 'locked'
                ? BASE.replace('false', 'true')
                : mode === 'malformed'
                  ? BASE.replace('user:end', 'user:broken')
                  : BASE.replace('Old', 'My generated edit');
          if (mode === 'deleted') await unlink(join(connection.managedRoot, 'note.md'));
          else await writeFile(join(connection.managedRoot, 'note.md'), current);
          const before = repository.get('note_a');
          const first = await service.publish(publication(NEXT));
          expect(first).toEqual({
            kind: 'conflict_preserved',
            currentPath: 'note.md',
            candidatePath: 'note-AI-충돌-20260907T010203000Z-r1-ca06c680aa64.md',
          });
          if (first.kind !== 'conflict_preserved') throw new Error('EXPECTED_CONFLICT');
          expect(await readFile(join(connection.managedRoot, first.candidatePath), 'utf8')).toBe(
            NEXT,
          );
          const second = await service.publish(publication(BASE));
          expect(second.kind).toBe('conflict_preserved');
          if (second.kind !== 'conflict_preserved') throw new Error('EXPECTED_CONFLICT');
          expect(second.candidatePath).not.toBe(first.candidatePath);
          expect(await readFile(join(connection.managedRoot, first.candidatePath), 'utf8')).toBe(
            NEXT,
          );
          expect(await readFile(join(connection.managedRoot, second.candidatePath), 'utf8')).toBe(
            BASE,
          );
          expect((await writer.readMarkdown('note.md'))?.content ?? null).toBe(
            mode === 'deleted' ? null : current,
          );
          expect(repository.get('note_a')).toEqual(before);
          expect(repository.conflicts('note_a')).toMatchObject([
            {
              currentPath: 'note.md',
              candidatePath: first.candidatePath,
              currentHash: mode === 'deleted' ? null : hash(current),
              candidateHash: hash(NEXT),
            },
            { candidatePath: second.candidatePath, candidateHash: hash(BASE) },
          ]);
          expect(() =>
            database?.prepare('UPDATE managed_note_conflicts SET reason = ?').run('locked'),
          ).toThrow();
          expect(() => database?.prepare('DELETE FROM managed_note_conflicts').run()).toThrow();
          expect(() =>
            database
              ?.prepare(
                'INSERT OR REPLACE INTO managed_note_conflicts SELECT * FROM managed_note_conflicts LIMIT 1',
              )
              .run(),
          ).toThrow();
          database.close();
          database = openDatabase(join(directory, 'db.sqlite'));
          expect(createRepositories(database).managedNotes.get('note_a')).toEqual(before);
          expect(createRepositories(database).managedNotes.conflicts('note_a')).toHaveLength(2);
        } finally {
          database?.close();
        }
      });
    },
  );

  it('turns a late writer hash mismatch into an audited actual conflict path', async () => {
    await withTempDirectory(async (directory) => {
      let database: SqliteDatabase | undefined;
      try {
        const connection = await new VaultService().connect({
          path: join(directory, 'vault'),
          mode: 'create',
        });
        database = openDatabase(join(directory, 'db.sqlite'));
        const repository = createRepositories(database).managedNotes;
        await new ManagedNoteService(
          repository,
          new VaultWriter(connection),
          () => new Date(NOW),
        ).publish(publication());
        let changed = false;
        const writer = new VaultWriter(connection, {
          beforeMutation: async ({ kind }) => {
            if (kind === 'open-temp' && !changed) {
              changed = true;
              await writeFile(join(connection.managedRoot, 'note.md'), 'late user edit');
            }
          },
        });
        const result = await new ManagedNoteService(
          repository,
          writer,
          () => new Date(NOW),
        ).publish(publication(NEXT));
        expect(result.kind).toBe('conflict_preserved');
        if (result.kind !== 'conflict_preserved') throw new Error('EXPECTED_CONFLICT');
        expect(await readFile(join(connection.managedRoot, 'note.md'), 'utf8')).toBe(
          'late user edit',
        );
        expect(await readFile(join(connection.managedRoot, result.candidatePath), 'utf8')).toBe(
          NEXT,
        );
        expect(repository.conflicts('note_a')[0]).toMatchObject({
          candidatePath: result.candidatePath,
          currentHash: hash('late user edit'),
          reason: 'writer_conflict',
        });
        expect(repository.get('note_a')?.generatedBase).toBe(BASE);
      } finally {
        database?.close();
      }
    });
  });

  it('fails closed on stale revisions, path collisions, and mutation of immutable history', async () => {
    await withTempDirectory(async (directory) => {
      let database: SqliteDatabase | undefined;
      try {
        database = openDatabase(join(directory, 'db.sqlite'));
        const repository = createRepositories(database).managedNotes;
        repository.append(revision(), null);
        expect(() => repository.append(revision(), null)).toThrow();
        expect(() =>
          repository.append(
            { ...revision(), stableId: 'note_b', relativePath: 'NOTE.md', pathKey: 'note.md' },
            null,
          ),
        ).toThrow();
        expect(() =>
          database?.prepare('UPDATE managed_note_history SET generation_revision = ?').run('r2'),
        ).toThrow();
        expect(() => database?.prepare('DELETE FROM managed_note_history').run()).toThrow();
        expect(() =>
          database
            ?.prepare(`INSERT OR REPLACE INTO managed_note_history
          (rowid, stable_id, relative_path, path_key, generated_base, generated_base_hash, published_hash,
           generation_revision, revision, decision, created_at, updated_at)
          SELECT rowid, stable_id, relative_path, path_key, generated_base, generated_base_hash, published_hash,
           generation_revision, revision + 1, decision, created_at, updated_at FROM managed_note_history`)
            .run(),
        ).toThrow();
        expect(repository.history('note_a')).toEqual([revision()]);
        expect(repository.get('note_b')).toBeNull();
      } finally {
        database?.close();
      }
    });
  });

  it('surfaces DB failure after publication and keeps the old base for conservative restart recovery', async () => {
    await withTempDirectory(async (directory) => {
      let database: SqliteDatabase | undefined;
      try {
        const connection = await new VaultService().connect({
          path: join(directory, 'vault'),
          mode: 'create',
        });
        const writer = new VaultWriter(connection);
        database = openDatabase(join(directory, 'db.sqlite'));
        const repository = createRepositories(database).managedNotes;
        const service = new ManagedNoteService(repository, writer, () => new Date(NOW));
        await service.publish(publication());
        const user = BASE.replace('\nnotes\n', '\nKEEP ME  \n');
        await writeFile(join(connection.managedRoot, 'note.md'), user);
        database
          .prepare(
            "CREATE TRIGGER fail_managed_append BEFORE INSERT ON managed_note_history BEGIN SELECT RAISE(ABORT, 'DB_FAIL'); END",
          )
          .run();
        await expect(service.publish(publication(NEXT))).rejects.toThrow();
        expect(await readFile(join(connection.managedRoot, 'note.md'), 'utf8')).toBe(
          NEXT.replace('\nnotes\n', '\nKEEP ME  \n'),
        );
        expect(repository.get('note_a')?.generatedBase).toBe(BASE);
        database.prepare('DROP TRIGGER fail_managed_append').run();
        database.close();
        database = openDatabase(join(directory, 'db.sqlite'));
        expect(
          (
            await new ManagedNoteService(
              createRepositories(database).managedNotes,
              writer,
              () => new Date(NOW),
            ).publish(publication(NEXT))
          ).kind,
        ).toBe('conflict_preserved');
      } finally {
        database?.close();
      }
    });
  });

  it('rejects concurrent stale acceptance through separate SQLite connections', async () => {
    await withTempDirectory(async (directory) => {
      let first: SqliteDatabase | undefined;
      let second: SqliteDatabase | undefined;
      try {
        first = openDatabase(join(directory, 'db.sqlite'));
        second = openDatabase(join(directory, 'db.sqlite'));
        const a = createRepositories(first).managedNotes;
        const b = createRepositories(second).managedNotes;
        a.append(revision(), null);
        const snapshot = b.get('note_a');
        expect(snapshot?.revision).toBe(0);
        a.append({ ...revision(NEXT), revision: 1 }, 0);
        expect(() =>
          b.append({ ...revision(), revision: 1 }, snapshot?.revision ?? null),
        ).toThrow();
        expect(b.get('note_a')?.generatedBase).toBe(NEXT);
        expect(b.history('note_a', 0, 1)).toMatchObject([{ revision: 1 }]);
      } finally {
        second?.close();
        first?.close();
      }
    });
  });

  it('does not let a second identity recreate a deleted owned path', async () => {
    await withTempDirectory(async (directory) => {
      let database: SqliteDatabase | undefined;
      try {
        const connection = await new VaultService().connect({
          path: join(directory, 'vault'),
          mode: 'create',
        });
        database = openDatabase(join(directory, 'db.sqlite'));
        const repository = createRepositories(database).managedNotes;
        const writer = new VaultWriter(connection);
        const service = new ManagedNoteService(repository, writer, () => new Date(NOW));
        await service.publish(publication());
        await unlink(join(connection.managedRoot, 'note.md'));
        const result = await service.publish({
          ...publication(NEXT),
          stableId: 'note_b',
          relativePath: 'NOTE.md',
        });
        expect(result.kind).toBe('conflict_preserved');
        expect(await writer.readMarkdown('note.md')).toBeNull();
        expect(repository.get('note_b')).toBeNull();
        expect(repository.conflicts('note_b')).toMatchObject([
          { reason: 'path_owned', currentHash: null },
        ]);
      } finally {
        database?.close();
      }
    });
  });

  it('keeps files intact when SQLite is already unavailable before publication', async () => {
    await withTempDirectory(async (directory) => {
      let database: SqliteDatabase | undefined;
      try {
        const connection = await new VaultService().connect({
          path: join(directory, 'vault'),
          mode: 'create',
        });
        database = openDatabase(join(directory, 'db.sqlite'));
        const service = new ManagedNoteService(
          createRepositories(database).managedNotes,
          new VaultWriter(connection),
        );
        database.close();
        await expect(service.publish(publication())).rejects.toThrow();
        expect(await new VaultWriter(connection).readMarkdown('note.md')).toBeNull();
      } finally {
        database?.close();
      }
    });
  });
});

describe('managed revision input validation', () => {
  it('rejects invalid hashes, incoherent contents, paths, revisions and hostile objects before getters', () => {
    let reads = 0;
    expect(() =>
      parseManagedNotePublication({
        ...publication(),
        get content() {
          reads++;
          return BASE;
        },
      }),
    ).toThrow();
    expect(reads).toBe(0);
    for (const change of [
      { generatedBaseHash: 'A'.repeat(64) },
      { generatedBase: NEXT },
      { pathKey: 'other.md' },
      { relativePath: '../escape.md' },
      { revision: Number.MAX_SAFE_INTEGER + 1 },
      { createdAt: 'yesterday' },
      { excess: true },
    ]) {
      expect(() => parseManagedNoteRevision({ ...revision(), ...change })).toThrow();
    }
    expect(Object.isFrozen(parseManagedNoteRevision(revision()))).toBe(true);
  });
});
