import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';

import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Schedule } from 'effect';
import { describe, expect } from 'vitest';

import {
  createNodeFileLocks,
  nodeFileLocks,
} from '@platform/defaults/fileLocks';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

const tempDirs = useTempDirs();

describe('nodeFileLocks', () => {
  // `it.live`: proper-lockfile refreshes on its own real timer, so this case
  // must run on the real clock rather than the TestClock `it.effect` installs.
  it.live(
    'refreshes a lock while a long critical section is still held',
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() =>
          makeTempDir('texra-file-lock-refresh-', tempDirs),
        );
        const lockPath = join(root, 'executionLocks', 'a8644b');
        // A short refresh interval exercises the same mtime-refresh mechanism
        // as the default tuning without holding the critical section for
        // seconds.
        const locks = createNodeFileLocks({
          staleMs: 5_000,
          updateMs: 50,
          retries: 0,
        });

        yield* locks.withFileLock(lockPath)(
          Effect.gen(function* () {
            const lockDirectory = `${lockPath}.lock`;
            const mtime = Effect.promise(() =>
              stat(lockDirectory).then((s) => s.mtimeMs),
            );
            const initialMtime = yield* mtime;
            // Poll for the mtime bump instead of sleeping a fixed window, so a
            // slow CI scheduler delays the assertion rather than failing it.
            const refreshedMtime = yield* Effect.retry(
              Effect.filterOrFail(
                mtime,
                (current) => current > initialMtime,
                () => 'not refreshed yet' as const,
              ),
              { schedule: Schedule.spaced('20 millis') },
            ).pipe(Effect.timeout('5 seconds'));
            expect(refreshedMtime).toBeGreaterThan(initialMtime);
          }),
        );
      }),
    { timeout: 20_000 },
  );

  it.effect('serializes independent callers using the same shared path', () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() =>
        makeTempDir('texra-file-lock-', tempDirs),
      );
      const lockPath = join(root, 'executionLocks', 'a8644a');
      const firstEntered = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      let secondEntered = false;

      const first = yield* Effect.forkChild(
        nodeFileLocks.withFileLock(lockPath)(
          Deferred.succeed(firstEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseFirst)),
          ),
        ),
      );
      yield* Deferred.await(firstEntered);
      const second = yield* Effect.forkChild(
        nodeFileLocks.withFileLock(lockPath)(
          Effect.sync(() => {
            secondEntered = true;
          }),
        ),
      );
      // The lane chains the second caller behind the first's hand-off, so no
      // timer can admit it early; flushing macrotask turns gives any pending
      // scheduling a deterministic chance to run instead of a wall-clock wait.
      for (let turn = 0; turn < 5; turn += 1) {
        yield* Effect.promise(() => setImmediate());
      }
      expect(secondEntered).toBe(false);

      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(secondEntered).toBe(true);
    }),
  );

  it.effect(
    'admits waiting callers in arrival order ahead of a later one',
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() =>
          makeTempDir('texra-file-lock-fifo-', tempDirs),
        );
        const lockPath = join(root, 'executionLocks', 'a8644c');
        const entered: string[] = [];
        const firstIn = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const enter = (name: string) =>
          nodeFileLocks.withFileLock(lockPath)(
            Effect.sync(() => {
              entered.push(name);
            }),
          );

        const first = yield* Effect.forkChild(
          nodeFileLocks.withFileLock(lockPath)(
            Effect.sync(() => entered.push('first')).pipe(
              Effect.andThen(Deferred.succeed(firstIn, undefined)),
              Effect.andThen(Deferred.await(releaseFirst)),
            ),
          ),
        );
        yield* Deferred.await(firstIn);
        const second = yield* Effect.forkChild(enter('second'));
        for (let turn = 0; turn < 5; turn += 1) {
          yield* Effect.promise(() => setImmediate());
        }
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Fiber.join(first);
        // Started from the first caller's continuation while the second is
        // still waiting: a lane that wakes waiters in a scheduled task would
        // admit it first.
        const third = yield* Effect.forkChild(enter('third'));
        yield* Fiber.join(second);
        yield* Fiber.join(third);

        expect(entered).toEqual(['first', 'second', 'third']);
      }),
  );
});
