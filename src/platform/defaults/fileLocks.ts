import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';

import { lock, type LockOptions } from 'proper-lockfile';

import { KeyedMutex } from '@utils/core/keyedMutex';

import type { FileLockProvider } from '../interfaces';

const localLocks = new KeyedMutex<string>();

/** Per-caller tuning for {@link createNodeFileLocks}. */
export interface FileLockTuning {
  /** Stale horizon in ms. Shorter stalls do not prove the holder is dead. */
  staleMs: number;
  /**
   * Refresh interval in ms while the operation is still running. Omit to let
   * `proper-lockfile` use its own default (`stale / 2`).
   */
  updateMs?: number;
  retries: LockOptions['retries'];
}

/**
 * Builds native cross-process locks for local shared-storage paths, with a
 * caller-tunable stale/update/retry policy. `proper-lockfile` refreshes the
 * lock mtime at `update` while the operation is still running, so critical
 * sections may safely exceed the stale horizon.
 */
export function createNodeFileLocks(tuning: FileLockTuning): FileLockProvider {
  return {
    async runExclusive<T>(
      lockPath: string,
      operation: () => Promise<T>,
    ): Promise<T> {
      const canonicalPath = path.resolve(lockPath);
      return localLocks.runExclusive(canonicalPath, async () => {
        await mkdir(path.dirname(canonicalPath), { recursive: true });
        let compromised: Error | undefined;
        const release = await lock(canonicalPath, {
          realpath: false,
          stale: tuning.staleMs,
          ...(tuning.updateMs === undefined ? {} : { update: tuning.updateMs }),
          retries: tuning.retries,
          // proper-lockfile's default callback throws from its renewal timer,
          // outside runExclusive's promise. Retain the failure and return it at
          // this operation boundary instead of terminating the Node process.
          onCompromised: (error) => {
            compromised ??= error;
          },
        });

        let value: T | undefined;
        let operationFailure: unknown;
        try {
          value = await operation();
        } catch (error) {
          operationFailure = error;
        }

        let releaseFailure: unknown;
        try {
          await release();
        } catch (error) {
          // A compromised lock has already been marked released internally.
          // Its ERELEASED cleanup error carries less information than the
          // original compromise and must not replace it.
          if (!compromised) releaseFailure = error;
        }

        const failures = [operationFailure, compromised, releaseFailure].filter(
          (error) => error !== undefined,
        );
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
          throw new AggregateError(
            failures,
            `File lock failed: ${canonicalPath}`,
          );
        }
        return value as T;
      });
    },
  };
}

/** Default-tuned provider for general local shared-storage paths. */
export const nodeFileLocks: FileLockProvider = createNodeFileLocks({
  // Match the execution-liveness horizon: shorter stalls do not prove death.
  staleMs: 120_000,
  // Refresh well before another process may classify a held lock as stale.
  updateMs: 2_000,
  retries: {
    retries: 8,
    factor: 1.5,
    minTimeout: 25,
    maxTimeout: 250,
    randomize: true,
  },
});
