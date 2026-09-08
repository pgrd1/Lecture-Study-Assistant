import { type FileHandle, open, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { withTempDirectory } from '../../testkit/tempDirectory';
import { contentFixture, required } from './contentFixtures';

describe('content checkpoint race guards', () => {
  it('preserves classification when its route changes during payload publication', async () => {
    await withTempDirectory(async (root) => {
      const f = await contentFixture(root);
      try {
        const first = await f.services().classification.classifySources(f.input);
        const probe = await open(join(root, 'probe'), 'wx');
        const prototype = Object.getPrototypeOf(probe) as FileHandle;
        const originalSync = prototype.sync;
        await probe.close();
        const sync = vi.spyOn(prototype, 'sync').mockImplementation(async function (
          this: FileHandle,
        ) {
          await originalSync.call(this);
          sync.mockRestore();
          const route = required(f.repositories.providerRoutes.get('content_classification'));
          f.repositories.providerRoutes.update(
            { ...route, revision: route.revision + 1 },
            route.revision,
          );
        });
        try {
          await expect(
            f.services().classification.classifySources({
              ...f.input,
              prompts: { content_classification: { oneOffInstructions: 'Check again.' } },
            }),
          ).rejects.toThrow('PIPELINE_ARTIFACT_WRITE_FAILED');
          expect(f.calls).toHaveLength(2);
          expect(f.repositories.pipelineArtifacts.get(f.input.jobId, 'classification')).toEqual(
            first.artifact,
          );
        } finally {
          sync.mockRestore();
        }
      } finally {
        f.database.close();
      }
    });
  });
  it.each(['swap', 'corruption'] as const)(
    'refuses a cached child after parent %s during the child read',
    async (change) => {
      await withTempDirectory(async (root) => {
        const f = await contentFixture(root);
        try {
          const first = await f.services().extraction.extractSources(f.input);
          const parent = await f.services().classification.classifySources(f.input);
          const original = f.artifacts.read.bind(f.artifacts);
          const read = vi.spyOn(f.artifacts, 'read').mockImplementation(async (...args) => {
            const result = await original(...args);
            if (args[1] === 'extraction') {
              read.mockRestore();
              if (change === 'corruption')
                await writeFile(join(root, 'artifacts', parent.artifact.relativePath), '{}');
              else
                await f.artifacts.write({
                  jobId: f.input.jobId,
                  stage: 'classification',
                  schemaVersion: 2,
                  identity: parent.identity,
                  value: {
                    classifications: parent.value.classifications.map((c) => ({
                      ...c,
                      confidence: 0.5,
                    })),
                  },
                  operationReceipts: parent.operationReceipts,
                });
            }
            return result;
          });
          try {
            await expect(f.services().extraction.extractSources(f.input)).rejects.toThrow();
            expect(f.calls).toHaveLength(2);
            expect(f.repositories.pipelineArtifacts.get(f.input.jobId, 'extraction')).toEqual(
              first.artifact,
            );
          } finally {
            read.mockRestore();
          }
        } finally {
          f.database.close();
        }
      });
    },
  );

  it.each(['parent', 'child'] as const)(
    'refuses cached extraction after %s route changes during its read',
    async (routeKind) => {
      await withTempDirectory(async (root) => {
        const f = await contentFixture(root);
        try {
          const first = await f.services().extraction.extractSources(f.input);
          const original = f.artifacts.read.bind(f.artifacts);
          const read = vi.spyOn(f.artifacts, 'read').mockImplementation(async (...args) => {
            const result = await original(...args);
            if (args[1] === 'extraction') {
              read.mockRestore();
              const route = required(
                f.repositories.providerRoutes.get(
                  routeKind === 'parent' ? 'content_classification' : 'document_recognition',
                ),
              );
              f.repositories.providerRoutes.update(
                { ...route, revision: route.revision + 1 },
                route.revision,
              );
            }
            return result;
          });
          try {
            await expect(f.services().extraction.extractSources(f.input)).rejects.toMatchObject({
              code: 'PROVIDER_NOT_READY',
            });
            expect(f.calls).toHaveLength(2);
            expect(f.repositories.pipelineArtifacts.get(f.input.jobId, 'extraction')).toEqual(
              first.artifact,
            );
          } finally {
            read.mockRestore();
          }
        } finally {
          f.database.close();
        }
      });
    },
  );

  it.each(['parent-swap', 'parent-corruption', 'parent-route', 'child-route'] as const)(
    'preserves the previous pointer after %s during payload publication',
    async (change) => {
      await withTempDirectory(async (root) => {
        const f = await contentFixture(root);
        try {
          const first = await f.services().extraction.extractSources(f.input);
          const parent = await f.services().classification.classifySources(f.input);
          const probe = await open(join(root, 'probe'), 'wx');
          const prototype = Object.getPrototypeOf(probe) as FileHandle;
          const originalSync = prototype.sync;
          await probe.close();
          const sync = vi.spyOn(prototype, 'sync').mockImplementation(async function (
            this: FileHandle,
          ) {
            await originalSync.call(this);
            sync.mockRestore();
            if (change === 'parent-corruption')
              await writeFile(join(root, 'artifacts', parent.artifact.relativePath), '{}');
            else if (change === 'parent-swap')
              await f.artifacts.write({
                jobId: f.input.jobId,
                stage: 'classification',
                schemaVersion: 2,
                identity: parent.identity,
                value: {
                  classifications: parent.value.classifications.map((c) => ({
                    ...c,
                    confidence: 0.5,
                  })),
                },
                operationReceipts: parent.operationReceipts,
              });
            else {
              const route = required(
                f.repositories.providerRoutes.get(
                  change === 'parent-route' ? 'content_classification' : 'document_recognition',
                ),
              );
              f.repositories.providerRoutes.update(
                { ...route, revision: route.revision + 1 },
                route.revision,
              );
            }
          });
          try {
            await expect(
              f.services().extraction.extractSources({
                ...f.input,
                prompts: { document_recognition: { oneOffInstructions: 'Check again.' } },
              }),
            ).rejects.toThrow('PIPELINE_ARTIFACT_WRITE_FAILED');
            expect(f.calls).toHaveLength(3);
            expect(f.repositories.pipelineArtifacts.get(f.input.jobId, 'extraction')).toEqual(
              first.artifact,
            );
            const files = await readdir(join(root, 'artifacts', f.input.jobId));
            expect(
              files.filter((name) => name.startsWith('extraction-') && name.endsWith('.json')),
            ).toHaveLength(2);
          } finally {
            sync.mockRestore();
          }
        } finally {
          f.database.close();
        }
      });
    },
  );
});
