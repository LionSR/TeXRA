// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect } from 'vitest';

// Local imports
import { withRequestTimeout } from '@texra-ai/harness/plugins';

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
});
