import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DiagnosticsService } from '../../../src/application/diagnostics/diagnosticsService';
import type { SecretKey, SecretStore } from '../../../src/core/ports/secretStore';
import { AppSettingsSchema } from '../../../src/shared/contracts/settings';
import { jobFixture } from '../../testkit/fixtures';
import { withTempDirectory } from '../../testkit/tempDirectory';

const NOW = '2026-09-02T00:00:00.000Z';
const SENSITIVE_VAULT = 'C:\\Users\\student\\Obsidian\\김교수 자료';
const SENSITIVE_QUEUE = 'C:\\Users\\student\\iCloudDrive\\강의 원문';

const settings = AppSettingsSchema.parse({
  schemaVersion: 1,
  vaultPath: SENSITIVE_VAULT,
  icloudQueuePath: SENSITIVE_QUEUE,
  defaultSummaryMode: 'standard',
  autoStart: true,
  processingPaused: false,
  legalNoticeAcceptedAt: NOW,
  updatedAt: NOW,
  revision: 0,
});

const secretPresence = (present: readonly SecretKey[]): SecretStore =>
  Object.freeze({
    set: async () => undefined,
    get: async () => {
      throw new TypeError('DIAGNOSTICS_MUST_NOT_DECRYPT_SECRETS');
    },
    delete: async () => undefined,
    has: async (key: SecretKey) => present.includes(key),
  });

const createService = (
  overrides: Partial<ConstructorParameters<typeof DiagnosticsService>[0]> = {},
) =>
  new DiagnosticsService({
    database: { getSchemaVersion: () => 1 },
    jobs: {
      list: () => [
        jobFixture({
          status: 'completed',
          lastSuccessfulStatus: 'completed',
          stagedSourcePath: 'C:\\Users\\student\\강의 원문.m4a',
        }),
        jobFixture({
          id: '33333333-3333-4333-8333-333333333333',
          fingerprint: 'a'.repeat(64),
          status: 'retryable_failed',
          lastSuccessfulStatus: 'source_ready',
          retryCount: 1,
          errorCode: 'SOURCE_HASH_FAILED',
        }),
      ],
    },
    settings: { get: () => settings },
    secrets: secretPresence(['openai_api_key', 'gemini_api_key']),
    runtime: {
      appVersion: '0.1.0',
      electronVersion: '44.1.0',
      nodeVersion: '24.19.0',
      platform: 'win32',
      arch: 'x64',
    },
    clock: () => NOW,
    saltGenerator: () => Buffer.alloc(32, 7),
    ...overrides,
  });

describe('DiagnosticsService', () => {
  it('exports aggregate state without secrets, paths, names, or lecture content', async () => {
    await withTempDirectory(async (directory) => {
      const destination = join(directory, 'diagnostics.json');
      const service = createService();

      await expect(service.export(destination)).resolves.toBe(destination);
      const raw = await readFile(destination, 'utf8');
      const report = JSON.parse(raw);

      expect(report).toMatchObject({
        reportVersion: 1,
        generatedAt: NOW,
        runtime: {
          appVersion: '0.1.0',
          electronVersion: '44.1.0',
          nodeVersion: '24.19.0',
          platform: 'win32',
          arch: 'x64',
        },
        databaseSchemaVersion: 1,
        settings: {
          configured: true,
          vaultConfigured: true,
          icloudQueueConfigured: true,
          vaultPathHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          icloudQueuePathHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
        secrets: {
          openai_api_key: true,
          gemini_api_key: true,
          anthropic_api_key: false,
        },
        jobs: {
          total: 2,
          byStatus: { completed: 1, retryable_failed: 1 },
          byErrorCode: { SOURCE_HASH_FAILED: 1 },
        },
      });
      expect(raw).not.toMatch(
        /sk-|secret-value|강의 원문|김교수|Users|student|Obsidian|iCloudDrive|\.m4a/iu,
      );
    });
  });

  it('uses a fresh private salt so path fingerprints cannot correlate across reports', async () => {
    await withTempDirectory(async (directory) => {
      const first = join(directory, 'first.json');
      const second = join(directory, 'second.json');
      await createService({ saltGenerator: () => Buffer.alloc(32, 1) }).export(first);
      await createService({ saltGenerator: () => Buffer.alloc(32, 2) }).export(second);

      const firstReport = JSON.parse(await readFile(first, 'utf8'));
      const secondReport = JSON.parse(await readFile(second, 'utf8'));
      expect(firstReport.settings.vaultPathHash).not.toBe(secondReport.settings.vaultPathHash);
      expect(JSON.stringify(firstReport)).not.toContain(Buffer.alloc(32, 1).toString('hex'));
    });
  });

  it('maps invalid destinations and sensitive dependency failures to a fixed error', async () => {
    await expect(createService().export('relative-diagnostics.json')).rejects.toMatchObject({
      code: 'DIAGNOSTICS_EXPORT_FAILED',
      displayMessage: '진단 보고서를 안전하게 내보내지 못했습니다.',
    });

    const service = createService({
      jobs: {
        list: () => {
          throw new Error('C:\\Users\\student\\강의 원문 secret-value');
        },
      },
    });
    await withTempDirectory(async (directory) => {
      await expect(service.export(join(directory, 'diagnostics.json'))).rejects.toMatchObject({
        code: 'DIAGNOSTICS_EXPORT_FAILED',
      });
    });
  });

  it('represents an unconfigured installation without inventing path fingerprints', async () => {
    await withTempDirectory(async (directory) => {
      const destination = join(directory, 'diagnostics.json');
      await createService({
        jobs: { list: () => [] },
        settings: { get: () => null },
        secrets: secretPresence([]),
      }).export(destination);

      const report = JSON.parse(await readFile(destination, 'utf8'));
      expect(report.settings).toEqual({
        configured: false,
        vaultConfigured: false,
        icloudQueueConfigured: false,
        vaultPathHash: null,
        icloudQueuePathHash: null,
        defaultSummaryMode: null,
        autoStart: null,
        processingPaused: null,
        legalNoticeAccepted: false,
      });
      expect(report.jobs.total).toBe(0);
    });
  });

  it('rejects weak salts and runtime values that could smuggle local paths', async () => {
    await withTempDirectory(async (directory) => {
      await expect(
        createService({ saltGenerator: () => Buffer.alloc(31) }).export(
          join(directory, 'diagnostics.json'),
        ),
      ).rejects.toMatchObject({ code: 'DIAGNOSTICS_EXPORT_FAILED' });
    });

    expect(() =>
      createService({
        runtime: {
          appVersion: SENSITIVE_VAULT,
          electronVersion: '44.1.0',
          nodeVersion: '24.19.0',
          platform: 'win32',
          arch: 'x64',
        },
      }),
    ).toThrow();
  });

  it('uses one frozen operation for presence reads and fails safely when cancelled', async () => {
    await withTempDirectory(async (directory) => {
      const seenOperations: unknown[] = [];
      const has = vi.fn(async (_key: SecretKey, operation: unknown) => {
        seenOperations.push(operation);
        return false;
      });
      const secrets: SecretStore = Object.freeze({
        set: async () => undefined,
        get: async () => undefined,
        delete: async () => undefined,
        has,
      });
      const controller = new AbortController();
      controller.abort();

      await expect(
        createService({ secrets }).export(join(directory, 'diagnostics.json'), controller.signal),
      ).rejects.toMatchObject({ code: 'DIAGNOSTICS_EXPORT_FAILED' });
      expect(has).not.toHaveBeenCalled();

      await createService({ secrets }).export(join(directory, 'active.json'));
      expect(seenOperations).toHaveLength(3);
      expect(new Set(seenOperations).size).toBe(1);
      expect(Object.isFrozen(seenOperations[0])).toBe(true);
    });
  });

  it('does not serialize a report when cancellation arrives during presence reads', async () => {
    await withTempDirectory(async (directory) => {
      const destination = join(directory, 'cancelled-diagnostics.json');
      const controller = new AbortController();
      const releases: Array<() => void> = [];
      const has = vi.fn(
        async () =>
          new Promise<boolean>((resolve) => {
            releases.push(() => resolve(false));
          }),
      );
      const secrets: SecretStore = Object.freeze({
        set: async () => undefined,
        get: async () => undefined,
        delete: async () => undefined,
        has,
      });

      const pending = createService({ secrets }).export(destination, controller.signal);
      await vi.waitFor(() => expect(has).toHaveBeenCalledTimes(3));
      controller.abort();
      for (const release of releases) release();

      await expect(pending).rejects.toMatchObject({
        code: 'DIAGNOSTICS_EXPORT_FAILED',
        displayMessage: '진단 보고서를 안전하게 내보내지 못했습니다.',
      });
      await expect(access(destination)).rejects.toBeDefined();
    });
  });

  it('does not publish a report when cancellation arrives during final filesystem setup', async () => {
    await withTempDirectory(async (directory) => {
      const destination = join(directory, 'cancelled-before-commit.json');
      const controller = new AbortController();
      let presenceReads = 0;
      const secrets: SecretStore = Object.freeze({
        set: async () => undefined,
        get: async () => undefined,
        delete: async () => undefined,
        has: async () => {
          presenceReads += 1;
          if (presenceReads === 3) setTimeout(() => controller.abort(), 0);
          return false;
        },
      });

      await expect(
        createService({ secrets }).export(destination, controller.signal),
      ).rejects.toMatchObject({ code: 'DIAGNOSTICS_EXPORT_FAILED' });
      await expect(access(destination)).rejects.toBeDefined();
    });
  });
});
