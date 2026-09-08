import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyMigrations, SQLITE_MIGRATIONS } from '../../src/infrastructure/db/migrations';
import {
  createRepositories,
  openDatabase,
  SqliteDatabase,
} from '../../src/infrastructure/db/sqliteDatabase';
import { createJsonPipelineArtifactStore } from '../../src/infrastructure/filesystem/jsonPipelineArtifactStore';
import {
  PipelineArtifactSchema,
  PipelineArtifactWriteSchema,
} from '../../src/shared/contracts/pipelineArtifact';
import { courseFixture, jobFixture } from '../testkit/fixtures';
import { withTempDirectory } from '../testkit/tempDirectory';
import { classification, contentFixture, required } from '../unit/application/contentFixtures';

describe('versioned aggregate pipeline checkpoints', () => {
  it('preserves v1 payload and pointer across migration8→9, then roundtrips v2 after a real database reopen', async () => {
    await withTempDirectory(async (root) => {
      const path = join(root, 'legacy.sqlite');
      const raw = new DatabaseSync(path);
      raw.exec('PRAGMA foreign_keys = ON');
      applyMigrations(raw, SQLITE_MIGRATIONS.slice(0, 8));
      const database = new SqliteDatabase(raw);
      const repos = createRepositories(database);
      repos.courses.insert(courseFixture());
      repos.jobs.insert(jobFixture());
      const artifactRoot = join(root, 'legacy-artifacts');
      await mkdir(artifactRoot);
      const store = await createJsonPipelineArtifactStore(artifactRoot, repos.pipelineArtifacts);
      const id = '33333333-3333-4333-8333-333333333333';
      const identity = {
        sources: [{ sourceId: id, sha256: 'a'.repeat(64) }],
        upstream: [],
        prompt: { id: 'legacy', version: 'v1', sha256: 'b'.repeat(64) },
        route: {
          feature: 'content_classification',
          providerId: 'openai_api',
          modelId: 'test',
          revision: 1,
        },
      } as const;
      const old = await store.write(
        PipelineArtifactWriteSchema.parse({
          jobId: jobFixture().id,
          stage: 'classification',
          schemaVersion: 1,
          identity,
          value: classification(id),
        }),
      );
      const bytes = await readFile(join(artifactRoot, old.relativePath));
      database.close();
      const reopened = openDatabase(path);
      try {
        expect(reopened.getSchemaVersion()).toBe(10);
        const newStore = await createJsonPipelineArtifactStore(
          artifactRoot,
          createRepositories(reopened).pipelineArtifacts,
        );
        expect(await newStore.read(old.jobId, old.stage, identity, 1)).toMatchObject(old);
        expect(await newStore.read(old.jobId, old.stage, identity, 2)).toBeNull();
        expect(await readFile(join(artifactRoot, old.relativePath))).toEqual(bytes);
        for (const stage of ['extraction', 'evidence', 'clustering', 'synthesis', 'verification']) {
          expect(() =>
            reopened
              .prepare(
                'UPDATE pipeline_artifacts SET stage = ?, schema_version = 2 WHERE job_id = ?',
              )
              .run(stage, old.jobId),
          ).toThrow();
        }
      } finally {
        reopened.close();
      }

      const f = await contentFixture(root);
      const result = await f.services().classification.classifySources(f.input);
      f.database.close();
      const v2Reopened = openDatabase(join(root, 'study.sqlite'));
      try {
        const v2Store = await createJsonPipelineArtifactStore(
          join(root, 'artifacts'),
          createRepositories(v2Reopened).pipelineArtifacts,
        );
        expect(
          await v2Store.read(result.artifact.jobId, 'classification', result.identity, 2),
        ).toMatchObject({ value: result.value, schemaVersion: 2 });
        expect(
          await v2Store.read(result.artifact.jobId, 'classification', result.identity, 1),
        ).toBeNull();
      } finally {
        v2Reopened.close();
      }
    });
  });

  it('rejects unreviewed stage/version pairs in the closed metadata contract', () => {
    for (const stage of ['extraction', 'evidence', 'clustering', 'synthesis', 'verification']) {
      expect(() =>
        PipelineArtifactSchema.parse({
          jobId: jobFixture().id,
          stage,
          schemaVersion: 2,
          relativePath: `${jobFixture().id}/${stage}-v2-${'a'.repeat(64)}.json`,
          sha256: 'a'.repeat(64),
          identitySha256: 'b'.repeat(64),
          createdAt: '2026-09-07T00:00:00.000Z',
        }),
      ).toThrow();
    }
  });

  it('requires exact ordered application receipts and preserves them on cache hits', async () => {
    await withTempDirectory(async (root) => {
      const f = await contentFixture(root, 2);
      try {
        const result = await f.services().classification.classifySources(f.input);
        expect(
          (await f.services().classification.classifySources(f.input)).operationReceipts,
        ).toEqual(result.operationReceipts);
        const write = {
          jobId: f.input.jobId,
          stage: 'classification',
          schemaVersion: 2,
          identity: result.identity,
          value: result.value,
        };
        for (const operationReceipts of [
          undefined,
          [],
          [result.operationReceipts[0]],
          [...result.operationReceipts].reverse(),
          result.operationReceipts.map((receipt) => ({
            ...receipt,
            requestId: required(result.operationReceipts[0]).requestId,
          })),
          result.operationReceipts.map((receipt) => ({
            ...receipt,
            path: 'C:/private/source.pdf',
          })),
        ]) {
          expect(() =>
            PipelineArtifactWriteSchema.parse({ ...write, operationReceipts }),
          ).toThrow();
        }
        expect(f.calls).toHaveLength(2);
      } finally {
        f.database.close();
      }
    });
  });
});
