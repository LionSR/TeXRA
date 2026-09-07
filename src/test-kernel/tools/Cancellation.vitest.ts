// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Exit, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect } from 'vitest';

// Local imports
import { ToolError } from '@shared/schemas';
import { withRequestTimeout } from '@tools/timeouts';
import { rateLimitedApiCall } from '@tools/support/rateLimiter';

/** The rate-limited lookup of `operation` as a tool program runs it. */
const lookup = <T>(operation: () => Promise<T>) =>
  rateLimitedApiCall('test-api', 0, 'Lookup failed', operation);

/** Let the forked lookup take its slot and start its request. */
const started = Effect.promise(
  () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
);

describe('rateLimitedApiCall cancellation', () => {
  it.effect('succeeds with the operation result', () =>
    Effect.gen(function* () {
      expect(yield* lookup(() => Promise.resolve(42))).toBe(42);
    }),
  );

  it.effect('interrupting the program abandons an in-flight operation', () =>
    Effect.gen(function* () {
      let requests = 0;
      const fiber = yield* Effect.forkChild(
        lookup(() => {
          requests += 1;
          return new Promise<never>(() => {});
        }),
      );
      yield* started;
      expect(requests).toBe(1);
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit) && Exit.hasInterrupts(exit)).toBe(true);
    }),
  );

  it.effect(
    'an abandoned operation rejection after interruption is observed',
    () =>
      Effect.gen(function* () {
        let rejectOperation: (error: Error) => void = () => {};
        const operation = new Promise<never>((_, reject) => {
          rejectOperation = reject;
        });
        const fiber = yield* Effect.forkChild(lookup(() => operation));
        yield* started;
        yield* Fiber.interrupt(fiber);
        // The orphaned rejection must not become an unhandled rejection.
        rejectOperation(new Error('late network failure'));
        yield* Effect.promise(
          () => new Promise((resolve) => setTimeout(resolve, 10)),
        );
      }),
  );

  it.effect('wraps the operation error in the failure message', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        lookup(() => Promise.reject(new Error('boom'))),
      );
      expect(error).toEqual(new ToolError('Lookup failed: boom'));
    }),
  );

  it.effect('passes a ToolError the operation throws through unchanged', () =>
    Effect.gen(function* () {
      const thrown = new ToolError('No such record', { summary: 'Missing' });
      const error = yield* Effect.flip(lookup(() => Promise.reject(thrown)));
      expect(error).toBe(thrown);
    }),
  );
});

/**
 * `callZoteroConnector` runs its non-idempotent `saveItems`/`saveSnapshot`
 * write under `Effect.uninterruptible` so cancelling a run cannot tear it
 * mid-request and lose the outcome. That rests on one non-obvious property of
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
            withRequestTimeout(1000, (signal) => {
              signal.addEventListener('abort', () => {
                aborted = true;
              });
              return new Promise<never>(() => {});
            }),
          ),
        ),
      );
      yield* started;
      yield* TestClock.adjust('1000 millis');
      const error = yield* Fiber.join(fiber);
      expect(error._tag).toBe('RequestTimedOut');
      expect(aborted).toBe(true);
    }),
  );

  it.effect('lets an interrupted request settle instead of tearing it', () =>
    Effect.gen(function* () {
      let aborted = false;
      let settled = false;
      let finish: () => void = () => {};
      const fiber = yield* Effect.forkChild(
        Effect.uninterruptible(
          withRequestTimeout(1000, (signal) => {
            signal.addEventListener('abort', () => {
              aborted = true;
            });
            return new Promise<string>((resolve) => {
              finish = () => {
                settled = true;
                resolve('written');
              };
            });
          }),
        ),
      );
      yield* started;
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber));
      yield* started;
      // The interrupt is deferred: the write is untouched and still in flight.
      expect(aborted).toBe(false);
      expect(settled).toBe(false);
      finish();
      yield* Fiber.join(interrupting);
      // The write ran to completion, and only then did the interrupt land.
      expect(settled).toBe(true);
      expect(aborted).toBe(false);
      expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);
    }),
  );
});

describe('withRequestTimeout misuse', () => {
  it.effect('dies on a request that declares no AbortSignal parameter', () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        withRequestTimeout(1000, () => Promise.resolve('unabortable')),
      );
      expect(Exit.hasDies(exit)).toBe(true);
    }),
  );
});
