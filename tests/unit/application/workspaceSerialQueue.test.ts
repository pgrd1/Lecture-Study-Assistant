import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runWorkspaceExclusive } from '../../../src/application/obsidian/workspaceSerialQueue';
import { deferred } from '../../testkit/deferred';
import { withTempDirectory } from '../../testkit/tempDirectory';

describe('workspace process-local serialization', () => {
  it('serializes canonical identities, recovers from failure, and leaves other workspaces independent', () =>
    withTempDirectory(async (root) => {
      const other = join(root, 'other');
      await mkdir(other);
      const started = deferred();
      const release = deferred();
      const order: string[] = [];
      const first = runWorkspaceExclusive(root, async () => {
        started.resolve();
        await release.promise;
        order.push('first');
        throw new Error('publication failed');
      });
      const failed = expect(first).rejects.toThrow('publication failed');
      await started.promise;
      const second = runWorkspaceExclusive(join(root, 'other', '..'), async () => {
        order.push('second');
        return 'accepted';
      });
      expect(await runWorkspaceExclusive(other, async () => 'independent')).toBe('independent');
      expect(order).toEqual([]);
      release.resolve();
      await failed;
      expect(await second).toBe('accepted');
      expect(order).toEqual(['first', 'second']);
    }));

  it('cancels queued work promptly without releasing a running critical section', () =>
    withTempDirectory(async (root) => {
      const started = deferred();
      const release = deferred();
      const first = runWorkspaceExclusive(root, async () => {
        started.resolve();
        await release.promise;
      });
      await started.promise;
      const controller = new AbortController();
      let calls = 0;
      const cancelled = runWorkspaceExclusive(
        root,
        async () => {
          calls++;
        },
        controller.signal,
      );
      const rejected = expect(cancelled).rejects.toThrow('cancel queued');
      controller.abort(new Error('cancel queued'));
      await rejected;
      const next = runWorkspaceExclusive(root, async () => {
        calls++;
      });
      expect(calls).toBe(0);
      release.resolve();
      await first;
      await next;
      expect(calls).toBe(1);
      await expect(
        runWorkspaceExclusive(
          root,
          async () => {
            calls++;
          },
          controller.signal,
        ),
      ).rejects.toThrow('cancel queued');
      expect(calls).toBe(1);
    }));

  it('bounds queued work and frees capacity after completion', () =>
    withTempDirectory(async (root) => {
      const release = deferred();
      const work = Array.from({ length: 64 }, () =>
        runWorkspaceExclusive(root, () => release.promise),
      );
      await expect(runWorkspaceExclusive(root, async () => undefined)).rejects.toThrow(
        'WORKSPACE_QUEUE_FULL',
      );
      release.resolve();
      await Promise.all(work);
      expect(await runWorkspaceExclusive(root, async () => 'recovered')).toBe('recovered');
    }));

  it('drains already-running work on cancellation before reporting completion', () =>
    withTempDirectory(async (root) => {
      const started = deferred();
      const release = deferred();
      const controller = new AbortController();
      const work = runWorkspaceExclusive(
        root,
        async () => {
          started.resolve();
          await release.promise;
          return 'drained';
        },
        controller.signal,
      );
      let settled = false;
      void work.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await started.promise;
      controller.abort(new Error('shutdown'));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      release.resolve();
      expect(await work).toBe('drained');
    }));

  it('rejects ambiguous roots and bounds the total number of independent queues', () =>
    withTempDirectory(async (root) => {
      await expect(runWorkspaceExclusive('relative', async () => undefined)).rejects.toThrow(
        'INVALID_WORKSPACE_QUEUE_ROOT',
      );
      const roots = Array.from({ length: 128 }, (_, n) => join(root, `workspace-${n}`));
      await Promise.all(roots.map((path) => mkdir(path)));
      const release = deferred();
      const work = roots.map((path) => runWorkspaceExclusive(path, () => release.promise));
      try {
        await expect(runWorkspaceExclusive(root, async () => undefined)).rejects.toThrow(
          'WORKSPACE_QUEUE_FULL',
        );
      } finally {
        release.resolve();
        await Promise.all(work);
      }
      expect(await runWorkspaceExclusive(root, async () => 'available')).toBe('available');
    }));
});
