import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';

type Queue = Readonly<{ tail: Promise<void>; count: number }>;
const queues = new Map<string, Queue>();

/** Process-local only: network calls never acquire the crash-sticky filesystem
 * publication lease. Keep cancelled entries until their predecessor drains so
 * cancellation cannot release a running critical section or bypass the bound. */
export async function runWorkspaceExclusive<T>(
  workspaceRoot: string,
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  if (!isAbsolute(workspaceRoot)) throw new TypeError('INVALID_WORKSPACE_QUEUE_ROOT');
  const canonical = realpathSync(workspaceRoot);
  const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  const previous = queues.get(key);
  if ((previous?.count ?? 0) >= 64 || (!previous && queues.size >= 128))
    throw new TypeError('WORKSPACE_QUEUE_FULL');
  let started = false;
  const work = (previous?.tail ?? Promise.resolve()).then(() => {
    signal?.throwIfAborted();
    started = true;
    return run();
  });
  const tail = work.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, { tail, count: (previous?.count ?? 0) + 1 });
  void tail.then(() => {
    const current = queues.get(key) as Queue;
    if (current.tail === tail) queues.delete(key);
    else queues.set(key, { ...current, count: current.count - 1 });
  });
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener('abort', aborted);
      if (!started) reject(signal.reason);
    };
    signal.addEventListener('abort', aborted, { once: true });
    void work.then(
      (value) => {
        signal.removeEventListener('abort', aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', aborted);
        reject(error);
      },
    );
  });
}
