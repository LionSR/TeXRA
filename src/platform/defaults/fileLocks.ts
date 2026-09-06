import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';

import { Cause, Effect, Exit, Result } from 'effect';
import { lock, type LockOptions } from 'proper-lockfile';

import { aggregateError } from '@utils/core';
import { type PerKeyLane, withPerKeyLane } from '@utils/core/perKeyQueue';

import type { FileLockProvider } from '../interfaces';

/** In-process lane per canonical lock path, shared by every provider. */
const localLocks = new Map<string, PerKeyLane>();

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
 * `proper-lockfile`'s cross-process lock on `canonicalPath` as a resource:
 * the acquire step creates the lock's directory and takes the lock with the
 * caller's tuning; the returned release step gives it back. Failures keep
 * their identity — `mkdir`'s `NodeJS.ErrnoException`, `proper-lockfile`'s
 * `Error` with its `code` (ELOCKED, ECOMPROMISED, …) — because hosts match
 * on them; the mappers only name the type. This is the migration's
 * foreign-boundary adapter case (PRD R7): the lock and fs errors are the
 * caller-facing identities, so no tagged error wraps them. A compromise
 * fires from `proper-lockfile`'s renewal timer, outside any fiber, so its
 * callback only records the error; the release step then reports it in place
 * of the ERELEASED cleanup error the release call raises for a lock already
 * marked released internally — that error carries less information than the
 * compromise itself.
 */
const acquireLock = Effect.fn('fileLocks.acquireLock')(function* (
  canonicalPath: string,
  tuning: FileLockTuning,
) {
  yield* Effect.tryPromise({
    try: () => mkdir(path.dirname(canonicalPath), { recursive: true }),
    catch: (cause) => cause as NodeJS.ErrnoException,
  });
  let compromised: Error | undefined;
  const release = yield* Effect.tryPromise({
    try: () =>
      lock(canonicalPath, {
        realpath: false,
        stale: tuning.staleMs,
        ...(tuning.updateMs === undefined ? {} : { update: tuning.updateMs }),
        retries: tuning.retries,
        onCompromised: (error) => {
          compromised ??= error;
        },
      }),
    catch: (cause) => cause as Error,
  });
  return Effect.gen(function* () {
    const released = yield* Effect.result(
      Effect.tryPromise({
        try: () => release(),
        catch: (cause) => cause as Error,
      }),
    );
    if (compromised) return yield* Effect.fail(compromised);
    if (Result.isFailure(released)) return yield* Effect.fail(released.failure);
  });
});

/**
 * Hold `lockPath`'s in-process lane and its cross-process lock around
 * `self`, releasing both on success, failure, and interruption. A failure
 * of `self`, of the lock, or of both reaches the caller as one value with
 * the identity the Promise API has always thrown: the lone error itself, or
 * one `AggregateError` naming the path when the operation and the lock both
 * failed. The lock's own errors are `proper-lockfile`'s (`code` ELOCKED,
 * ECOMPROMISED, …), which hosts match on, so nothing wraps them; they and
 * the directory's fs error are the `Error` the failure channel adds to
 * `self`'s own `E`. Defects and interruption pass through untouched.
 */
export function withFileLock(
  lockPath: string,
  tuning: FileLockTuning,
): <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E | Error, R> {
  const canonicalPath = path.resolve(lockPath);
  return <A, E, R>(self: Effect.Effect<A, E, R>) =>
    withPerKeyLane(
      localLocks,
      canonicalPath,
    )(
      Effect.acquireUseRelease(
        acquireLock(canonicalPath, tuning),
        () => self,
        (release) => release,
      ),
    ).pipe(
      Effect.catchCause((cause) => {
        const failures = cause.reasons.filter(Cause.isFailReason);
        if (failures.length !== cause.reasons.length) {
          return Effect.failCause(cause);
        }
        // `aggregateError` hands a lone failure back as-is and joins several
        // in an `AggregateError`, so the reduced value stays in `E | Error`.
        return Effect.fail(
          aggregateError(
            failures.map((reason) => reason.error),
            `File lock failed: ${canonicalPath}`,
          ) as E | Error,
        );
      }),
    );
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
      // Runs on Effect's default runtime, not `effectRuntime()`: hosts hand
      // `nodeFileLocks` to `createNodePlatform`, and the CLI and desktop
      // hosts open their `JsonStore`s (which flush through `withFileLock`),
      // before they call `installProcessRuntime` — see the CLI's
      // `initPlatform` (`createCliStateStores`, `openTexraConfigStores`, then
      // `installProcessRuntime`) — so the process runtime may not exist yet.
      // The site is pinned by the "Effect run boundaries" ratchet in
      // src/test-kernel/architecture/dependencyDirection.vitest.ts.
      // `operation` is the caller's own Promise, so its rejection keeps its
      // identity and its type stays `unknown` at this edge.
      const exit = await Effect.runPromiseExit(
        withFileLock(
          lockPath,
          tuning,
        )(
          Effect.tryPromise({
            try: () => operation(),
            catch: (cause) => cause,
          }),
        ),
      );
      if (Exit.isSuccess(exit)) return exit.value;
      throw Cause.squash(exit.cause);
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
