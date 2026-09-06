// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Exit, Fiber } from 'effect';
import { describe, expect } from 'vitest';

// Local imports
import { ToolError } from '@shared/schemas';
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
