// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Exit, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect } from 'vitest';

// Local imports
import { withRequestTimeout } from '@tools/timeouts';

/** Let the forked request start. */
const started = Effect.promise(
  () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
);

/**
 * `callZoteroConnector` runs its non-idempotent `saveItems`/`saveSnapshot`
 * write under `Effect.uninterruptible` so cancelling a run cannot tear it
 * mid-request. That rests on one non-obvious property of
 * the effect runtime: the region defers the *caller's* interrupt but not the
 * deadline, because `timeoutOrElse` races through `raceAllFirst`, which forks
 * both racers interruptible regardless of the enclosing region. An effect
 * upgrade that changed either half would turn an unresponsive Zotero into a
 * hang, or bring the torn write back — silently in both directions.
 */
describe('withRequestTimeout under Effect.uninterruptible', () => {
  it.effect('still ends the request at its deadline', () =>
    Effect.gen(function* () {
      let aborted = false;
      const fiber = yield* Effect.forkChild(
        Effect.flip(
          Effect.uninterruptible(
            withRequestTimeout(
              1000,
              Effect.gen(function* () {
                const signal = yield* Effect.abortSignal;
                signal.addEventListener('abort', () => {
                  aborted = true;
                });
                return yield* Effect.never;
              }),
            ),
          ),
        ),
      );
      yield* started;
      yield* TestClock.adjust('1000 millis');
      const error = yield* Fiber.join(fiber);
      expect(error._tag).toBe('TimeoutError');
      expect(aborted).toBe(true);
    }),
  );

  it.effect('lets an interrupted request settle instead of tearing it', () =>
    Effect.gen(function* () {
      let abortedBeforeSettlement = false;
      let settled = false;
      let finish: () => void = () => {};
      const fiber = yield* Effect.forkChild(
        Effect.uninterruptible(
          withRequestTimeout(
            1000,
            Effect.gen(function* () {
              const signal = yield* Effect.abortSignal;
              signal.addEventListener('abort', () => {
                if (!settled) abortedBeforeSettlement = true;
              });
              return yield* Effect.promise(
                () =>
                  new Promise<string>((resolve) => {
                    finish = () => {
                      settled = true;
                      resolve('written');
                    };
                  }),
              );
            }),
          ),
        ),
      );
      yield* started;
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber));
      yield* started;
      // The interrupt is deferred: the write is untouched and still in flight.
      expect(abortedBeforeSettlement).toBe(false);
      expect(settled).toBe(false);
      finish();
      yield* Fiber.join(interrupting);
      // The write ran to completion, and only then did the interrupt land.
      expect(settled).toBe(true);
      expect(abortedBeforeSettlement).toBe(false);
      expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);
    }),
  );
});
