import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRepositories, openDatabase } from '../../src/infrastructure/db/sqliteDatabase';
import type { PipelineArtifact } from '../../src/shared/contracts/pipelineArtifact';
import { courseFixture, jobFixture } from '../testkit/fixtures';
import { withTempDirectory } from '../testkit/tempDirectory';

const checkpoint = (sha256 = 'a'.repeat(64)): PipelineArtifact => ({
  jobId: jobFixture().id,
  stage: 'classification',
  schemaVersion: 1,
  relativePath: `${jobFixture().id}/classification-v1-${sha256}.json`,
  sha256,
  identitySha256: 'b'.repeat(64),
  createdAt: '2026-09-07T00:00:00.000Z',
});

describe('pipeline checkpoint repository', () => {
  it('updates one current pointer atomically and reopens it', async () => {
    await withTempDirectory((root) => {
      const file = join(root, 'study.sqlite');
      const database = openDatabase(file);
      try {
        const repositories = createRepositories(database);
        repositories.courses.insert(courseFixture());
        repositories.jobs.insert(jobFixture());
        const artifacts = repositories.pipelineArtifacts;
        expect(artifacts.get(jobFixture().id, 'classification')).toBeNull();
        artifacts.put(checkpoint());
        artifacts.put(checkpoint('c'.repeat(64)));
        expect(artifacts.get(jobFixture().id, 'classification')).toEqual(
          checkpoint('c'.repeat(64)),
        );
        expect(database.prepare('SELECT COUNT(*) AS count FROM pipeline_artifacts').get()).toEqual({
          count: 1,
        });
      } finally {
        database.close();
      }
      const reopened = openDatabase(file);
      try {
        expect(
          createRepositories(reopened).pipelineArtifacts.get(jobFixture().id, 'classification'),
        ).toEqual(checkpoint('c'.repeat(64)));
      } finally {
        reopened.close();
      }
    });
  });

  it('rejects a valid checkpoint with a missing parent job', async () => {
    await withTempDirectory((root) => {
      const database = openDatabase(join(root, 'study.sqlite'));
      try {
        expect(() => createRepositories(database).pipelineArtifacts.put(checkpoint())).toThrow();
      } finally {
        database.close();
      }
    });
  });

  it('rejects malformed identity metadata and path mismatch with valid parent jobs', async () => {
    await withTempDirectory((root) => {
      const database = openDatabase(join(root, 'study.sqlite'));
      try {
        const repositories = createRepositories(database);
        repositories.courses.insert(courseFixture());
        repositories.jobs.insert(jobFixture());
        const artifacts = repositories.pipelineArtifacts;
        artifacts.put(checkpoint());
        for (const overrides of [
          { relativePath: '../foreign.json' },
          { schemaVersion: 2 },
          { identitySha256: 'invalid' },
          { stage: 'unknown' },
          { relativePath: `${jobFixture().id}/evidence-v1-${'a'.repeat(64)}.json` },
        ])
          expect(() =>
            artifacts.put({ ...checkpoint(), ...overrides } as PipelineArtifact),
          ).toThrow();
        expect(() => artifacts.get('../escape', 'classification')).toThrow();
        expect(artifacts.get(jobFixture().id, 'classification')).toEqual(checkpoint());
      } finally {
        database.close();
      }
    });
  });
});
