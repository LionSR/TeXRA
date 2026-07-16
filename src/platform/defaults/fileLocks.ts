import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';

import { lock } from 'proper-lockfile';

import type { FileLockProvider } from '../interfaces';

const LOCK_STALE_MS = 10_000;
/** Refresh well before another process may classify a held lock as stale. */
const LOCK_UPDATE_MS = 2_000;
const LOCK_RETRIES = {
  retries: 8,
  factor: 1.5,
  minTimeout: 25,
  maxTimeout: 250,
  randomize: true,
} as const;

/**
 * Native cross-process locks for local shared-storage paths.
 * `proper-lockfile` refreshes the lock mtime at `update` while the operation is
 * still running, so critical sections may safely exceed the stale horizon.
 */
export const nodeFileLocks: FileLockProvider = {
  async runExclusive<T>(
    lockPath: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    await mkdir(path.dirname(lockPath), { recursive: true });
    const release = await lock(lockPath, {
      realpath: false,
      stale: LOCK_STALE_MS,
      update: LOCK_UPDATE_MS,
      retries: LOCK_RETRIES,
    });
    try {
      return await operation();
    } finally {
      await release();
    }
  },
};
