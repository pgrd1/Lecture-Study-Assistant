import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import {
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
import { describe, expect, it, vi } from 'vitest';
import type { PipelineArtifactRepository } from '../../src/core/ports/pipelineArtifactRepository';
import { createRepositories, openDatabase } from '../../src/infrastructure/db/sqliteDatabase';
import { createJsonPipelineArtifactStore } from '../../src/infrastructure/filesystem/jsonPipelineArtifactStore';
import type {
  PipelineArtifact,
  PipelineArtifactIdentity,
  PipelineArtifactWrite,
} from '../../src/shared/contracts/pipelineArtifact';
import { assertBoundedPipelineJson } from '../../src/shared/contracts/pipelineArtifact';
import { courseFixture, jobFixture } from '../testkit/fixtures';
import { withTempDirectory } from '../testkit/tempDirectory';

const SOURCE = '33333333-3333-4333-8333-333333333333';
const identity: PipelineArtifactIdentity = {
  sources: [{ sourceId: SOURCE, sha256: 'a'.repeat(64) }],
  upstream: [],
  prompt: { id: 'classification', version: 'v1', sha256: 'b'.repeat(64) },
  route: {
    feature: 'content_classification',
    providerId: 'codex_cli',
    modelId: 'gpt-5.5',
    revision: 0,
  },
};
const value = {
  sourceId: SOURCE,
  types: ['lecture_slides'] as const,
  sections: [],
  facts: [],
  confidence: 0.9,
  uncertainty: null,
  sessionDate: null,
};
const input: PipelineArtifactWrite = {
  jobId: jobFixture().id,
  stage: 'classification',
  schemaVersion: 1,
  identity,
  value,
};

const fixture = async (root: string) => {
  const dbPath = join(root, 'study.sqlite');
  const database = openDatabase(dbPath);
  const repositories = createRepositories(database);
  repositories.courses.insert(courseFixture());
  repositories.jobs.insert(jobFixture());
  const artifactRoot = join(root, 'artifacts');
  await mkdir(artifactRoot);
  const store = await createJsonPipelineArtifactStore(artifactRoot, repositories.pipelineArtifacts);
  return { database, dbPath, artifactRoot, store, repository: repositories.pipelineArtifacts };
};

describe('local JSON pipeline checkpoints', () => {
  it.each(['throw', 'abort', 'abort-return'] as const)(
    'runs an application guard after publication, preserving the old pointer on %s',
    async (mode) => {
      await withTempDirectory(async (root) => {
        const f = await fixture(root);
        try {
          const first = await f.store.write(input);
          const controller = new AbortController();
          const beforeCommit = vi.fn(async () => {
            const files = await readdir(join(f.artifactRoot, input.jobId));
            expect(files.filter((name) => name.endsWith('.json'))).toHaveLength(2);
            expect(f.repository.get(input.jobId, input.stage)).toEqual(first);
            if (mode !== 'throw') controller.abort();
            if (mode === 'abort-return') return;
            throw new Error('private guard details must not escape');
          });
          await expect(
            f.store.write(
              { ...input, value: { ...value, confidence: 0.8 } },
              { signal: controller.signal, beforeCommit },
            ),
          ).rejects.toThrow(
            mode !== 'throw' ? 'PIPELINE_ARTIFACT_CANCELLED' : 'PIPELINE_ARTIFACT_WRITE_FAILED',
          );
          expect(beforeCommit).toHaveBeenCalledTimes(1);
          expect(f.repository.get(input.jobId, input.stage)).toEqual(first);
          expect(await f.store.read(input.jobId, input.stage, identity)).toMatchObject(first);
        } finally {
          f.database.close();
        }
      });
    },
  );
  it('reports a fixed artifact error when a committed payload disappears without leaking local paths', async () => {
    await withTempDirectory(async (root) => {
      const f = await fixture(root);
      try {
        const first = await f.store.write(input);
        await unlink(join(f.artifactRoot, first.relativePath));
        await expect(f.store.read(input.jobId, input.stage, identity)).rejects.toThrow(
          'PIPELINE_ARTIFACT_READ_FAILED',
        );
      } finally {
        f.database.close();
      }
    });
  });

  it('counts exact escaped UTF-8 bytes and rejects excessive nodes and exotic properties before cloning', () => {
    expect(() => assertBoundedPipelineJson('x'.repeat(16 * 1024 * 1024 - 2))).not.toThrow();
    expect(() => assertBoundedPipelineJson('x'.repeat(16 * 1024 * 1024 - 1))).toThrow();
    expect(() =>
      assertBoundedPipelineJson({ text: '\u0001\n\t\r\b\f\\"é한😀\ud800' }),
    ).not.toThrow();
    for (const bad of [
      Array.from({ length: 250_001 }, () => null),
      new Array(2),
      Object.defineProperty([], 'extra', { value: true, enumerable: true }),
      { [Symbol('hidden')]: true },
      Object.create({ inherited: true }),
      Object.defineProperty({}, 'hidden', { value: true }),
    ])
      expect(() => assertBoundedPipelineJson(bad)).toThrow();
  });

  it('preserves the previous pointer when publication collides with a foreign directory', async () => {
    await withTempDirectory(async (root) => {
      const f = await fixture(root);
      try {
        const first = await f.store.write(input);
        const bytes = await readFile(join(f.artifactRoot, first.relativePath), 'utf8');
        const nextBytes = bytes.replace('"confidence":0.9', '"confidence":0.8');
        const nextHash = createHash('sha256').update(nextBytes).digest('hex');
        const collision = join(f.artifactRoot, input.jobId, `classification-v1-${nextHash}.json`);
        await mkdir(collision);
        await writeFile(join(collision, 'foreign.txt'), 'preserve');
        await expect(
          f.store.write({ ...input, value: { ...value, confidence: 0.8 } }),
        ).rejects.toThrow();
        expect(await f.store.read(input.jobId, input.stage, identity)).toMatchObject({
          sha256: first.sha256,
          value,
        });
        expect(await readFile(join(collision, 'foreign.txt'), 'utf8')).toBe('preserve');
      } finally {
        f.database.close();
      }
    });
  });

  it('cancels after flushing a real temporary file without advancing the committed checkpoint', async () => {
    await withTempDirectory(async (root) => {
      const f = await fixture(root);
      const first = await f.store.write(input);
      const probe = await open(join(root, 'probe'), 'wx');
      const prototype = Object.getPrototypeOf(probe) as FileHandle;
      const originalSync = prototype.sync;
      await probe.close();
      const controller = new AbortController();
      const sync = vi.spyOn(prototype, 'sync').mockImplementation(async function (
        this: FileHandle,
      ) {
        await originalSync.call(this);
        controller.abort();
      });
      try {
        await expect(
          f.store.write(
            { ...input, value: { ...value, confidence: 0.8 } },
            { signal: controller.signal },
          ),
        ).rejects.toThrow();
        expect(await f.store.read(input.jobId, input.stage, identity)).toMatchObject({
          sha256: first.sha256,
          value,
        });
        expect(await readdir(join(f.artifactRoot, input.jobId))).toEqual([
          `classification-v1-${first.sha256}.json`,
        ]);
      } finally {
        sync.mockRestore();
        f.database.close();
      }
    });
  });

  it('refuses a root replaced after connection and a junction substituted for a committed job directory', async () => {
    await withTempDirectory(async (root) => {
      const f = await fixture(root);
      try {
        await f.store.write(input);
        const original = join(root, 'original-artifacts');
        await rename(f.artifactRoot, original);
        await mkdir(f.artifactRoot);
        await expect(f.store.write(input)).rejects.toThrow();
        await expect(f.store.read(input.jobId, input.stage, identity)).rejects.toThrow();
        const newStore = await createJsonPipelineArtifactStore(f.artifactRoot, f.repository);
        await symlink(join(original, input.jobId), join(f.artifactRoot, input.jobId), 'junction');
        await expect(newStore.read(input.jobId, input.stage, identity)).rejects.toThrow();
        expect(await readdir(join(original, input.jobId))).toHaveLength(1);
      } finally {
        f.database.close();
      }
    });
  });

  it('publishes canonical immutable payloads and reads the same hash after a database restart', async () => {
    await withTempDirectory(async (root) => {
      const f = await fixture(root);
      let first: PipelineArtifact;
      try {
        first = await f.store.write(input);
        const bytes = await readFile(join(f.artifactRoot, first.relativePath));
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(first.sha256);
        expect(first.relativePath).toBe(`${input.jobId}/classification-v1-${first.sha256}.json`);
        expect(await f.store.read(input.jobId, input.stage, identity)).toMatchObject({
          ...first,
          identity,
          value,
        });
        const second = await f.store.write({ ...input, value: { ...value, confidence: 0.8 } });
        expect(second.sha256).not.toBe(first.sha256);
        expect(await readFile(join(f.artifactRoot, first.relativePath))).toEqual(bytes);
        await writeFile(join(f.artifactRoot, input.jobId, '.uncommitted.tmp'), '{}');
        await writeFile(
          join(f.artifactRoot, input.jobId, `evidence-v1-${'a'.repeat(64)}.json`),
          '{}',
        );
        expect(await f.store.read(input.jobId, 'evidence', identity)).toBeNull();
      } finally {
        f.database.close();
      }
      const reopened = openDatabase(f.dbPath);
      try {
        const store = await createJsonPipelineArtifactStore(
          f.artifactRoot,
          createRepositories(reopened).pipelineArtifacts,
        );
        expect(await store.read(input.jobId, input.stage, identity)).toMatchObject({
          value: { confidence: 0.8 },
        });
        expect(await readFile(join(f.artifactRoot, first.relativePath), 'utf8')).toContain('0.9');
      } finally {
        reopened.close();
      }
    });
  });

  it.each(['publication interruption', 'database failure'])(
    'preserves the prior checkpoint across %s and restart',
    async (failure) => {
      await withTempDirectory(async (root) => {
        const f = await fixture(root);
        const first = await f.store.write(input);
        const failing: PipelineArtifactRepository = {
          get: (...args) => f.repository.get(...args),
          put: (artifact) => {
            if (failure === 'database failure') f.database.close();
            if (failure === 'publication interruption') throw new Error('INTERRUPTED');
            return f.repository.put(artifact);
          },
        };
        try {
          const store = await createJsonPipelineArtifactStore(f.artifactRoot, failing);
          await expect(
            store.write({ ...input, value: { ...value, confidence: 0.7 } }),
          ).rejects.toThrow();
          expect(
            (await readdir(join(f.artifactRoot, input.jobId))).filter((name) =>
              name.endsWith('.json'),
            ),
          ).toHaveLength(2);
        } finally {
          f.database.close();
        }
        const reopened = openDatabase(f.dbPath);
        try {
          const store = await createJsonPipelineArtifactStore(
            f.artifactRoot,
            createRepositories(reopened).pipelineArtifacts,
          );
          expect(await store.read(input.jobId, input.stage, identity)).toMatchObject({
            sha256: first.sha256,
            value,
          });
        } finally {
          reopened.close();
        }
      });
    },
  );

  it('rejects stale source, upstream, prompt, route and model identities', async () => {
    await withTempDirectory(async (root) => {
      const f = await fixture(root);
      try {
        await f.store.write(input);
        for (const expected of [
          { ...identity, sources: [{ sourceId: SOURCE, sha256: 'c'.repeat(64) }] },
          { ...identity, upstream: [{ stage: 'extraction' as const, sha256: 'c'.repeat(64) }] },
          { ...identity, prompt: { ...identity.prompt, sha256: 'c'.repeat(64) } },
          { ...identity, route: { ...identity.route, revision: 1 } },
          { ...identity, route: { ...identity.route, modelId: 'other' } },
        ])
          expect(await f.store.read(input.jobId, input.stage, expected)).toBeNull();
      } finally {
        f.database.close();
      }
    });
  });

  it('rejects tampered bytes, forged valid-hash envelopes, oversized files and path metadata', async () => {
    await withTempDirectory(async (root) => {
      const f = await fixture(root);
      try {
        const first = await f.store.write(input);
        const path = join(f.artifactRoot, first.relativePath);
        await writeFile(path, '{}');
        await expect(f.store.read(input.jobId, input.stage, identity)).rejects.toThrow();
        await expect(f.store.write(input)).rejects.toThrow();
        const forged = JSON.stringify({ ...input, jobId: SOURCE });
        const sha256 = createHash('sha256').update(forged).digest('hex');
        const relativePath = `${input.jobId}/classification-v1-${sha256}.json`;
        await writeFile(join(f.artifactRoot, relativePath), forged);
        f.repository.put({ ...first, sha256, relativePath });
        await expect(f.store.read(input.jobId, input.stage, identity)).rejects.toThrow();
        await writeFile(join(f.artifactRoot, relativePath), ' '.repeat(16 * 1024 * 1024 + 1));
        await expect(f.store.read(input.jobId, input.stage, identity)).rejects.toThrow();
        f.database
          .prepare('UPDATE pipeline_artifacts SET relative_path = ?')
          .run('../foreign.json');
        await expect(f.store.read(input.jobId, input.stage, identity)).rejects.toThrow();
      } finally {
        f.database.close();
      }
    });
  });

  it('preflights depth, repeated-reference amplification, bytes, cycles and data descriptors before schema parsing', async () => {
    await withTempDirectory(async (root) => {
      const f = await fixture(root);
      try {
        let deep: unknown = null;
        for (let i = 0; i < 20000; i++) deep = { child: deep };
        let amplified: unknown = 'x';
        for (let i = 0; i < 30; i++) amplified = [amplified, amplified];
        const cycle: unknown[] = [];
        cycle.push(cycle);
        let getterCalls = 0;
        const getter = Object.defineProperty({}, 'types', {
          enumerable: true,
          get: () => {
            getterCalls++;
            return [];
          },
        });
        for (const bad of [
          deep,
          amplified,
          cycle,
          getter,
          new Date(),
          { ...value, extra: true },
          JSON.parse('{"__proto__":{}}'),
          { constructor: {} },
          { prototype: {} },
          { ...value, uncertainty: '한'.repeat(6 * 1024 * 1024) },
          [undefined],
          [Number.NaN],
        ])
          await expect(
            f.store.write({ ...input, value: bad } as PipelineArtifactWrite),
          ).rejects.toThrow();
        expect(getterCalls).toBe(0);
        expect(await readdir(f.artifactRoot)).toEqual([]);
        expect(f.repository.get(input.jobId, input.stage)).toBeNull();
      } finally {
        f.database.close();
      }
    });
  });

  it('validates every stage against its closed v1 schema', async () => {
    await withTempDirectory(async (root) => {
      const f = await fixture(root);
      try {
        for (const [stage, stageValue] of [
          ['extraction', { segments: [] }],
          ['evidence', { segments: [] }],
          ['clustering', { topics: [] }],
          ['synthesis', { claims: [], conflicts: [], sessionDates: [] }],
          ['verification', { claims: [], conflicts: [], sessionDates: [] }],
        ] as const) {
          await f.store.write({ ...input, stage, value: stageValue } as PipelineArtifactWrite);
          expect(await f.store.read(input.jobId, stage, identity)).toMatchObject({
            value: stageValue,
          });
          await expect(
            f.store.write({ ...input, stage, value } as unknown as PipelineArtifactWrite),
          ).rejects.toThrow();
        }
        await expect(
          f.store.write({ ...input, schemaVersion: 2 } as unknown as PipelineArtifactWrite),
        ).rejects.toThrow();
        await expect(f.store.write({ ...input, jobId: '../escape' })).rejects.toThrow();
        await expect(
          f.store.write({ ...input, identity: { ...identity, sources: [] } }),
        ).rejects.toThrow();
      } finally {
        f.database.close();
      }
    });
  });

  it('cancels before any publication and preserves committed payloads during concurrent writes', async () => {
    await withTempDirectory(async (root) => {
      const f = await fixture(root);
      try {
        await expect(f.store.write(input, { signal: AbortSignal.abort() })).rejects.toThrow();
        expect(await readdir(f.artifactRoot)).toEqual([]);
        const results = await Promise.all([
          f.store.write(input),
          f.store.write(input),
          f.store.write({ ...input, value: { ...value, confidence: 0.8 } }),
        ]);
        expect(results[0]?.sha256).toBe(results[1]?.sha256);
        const current = await f.store.read(input.jobId, input.stage, identity);
        expect(results.map((r) => r.sha256)).toContain(current?.sha256);
        expect(
          (await readdir(join(f.artifactRoot, input.jobId))).filter((name) =>
            name.endsWith('.json'),
          ),
        ).toHaveLength(2);
      } finally {
        f.database.close();
      }
    });
  });

  it('rejects junction roots and job directories without touching their external targets', async () => {
    await withTempDirectory(async (root) => {
      const f = await fixture(root);
      const foreign = join(root, 'foreign');
      await mkdir(foreign);
      const linked = join(root, 'linked');
      await symlink(foreign, linked, 'junction');
      try {
        await expect(createJsonPipelineArtifactStore(linked, f.repository)).rejects.toThrow();
        await symlink(foreign, join(f.artifactRoot, input.jobId), 'junction');
        await expect(f.store.write(input)).rejects.toThrow();
        expect(await readdir(foreign)).toEqual([]);
      } finally {
        f.database.close();
      }
    });
  });
});
