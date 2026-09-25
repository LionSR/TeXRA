import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber } from 'effect';
import { describe, expect } from 'vitest';

import { SharedAttempt } from '@utils/core/sharedAttempt';

describe('SharedAttempt', () => {
  it.effect(
    'interrupting the first caller leaves the shared attempt running for a joiner',
    () =>
      Effect.gen(function* () {
        const attempt = new SharedAttempt<string, never>();
        const latch = yield* Deferred.make<void>();
        let runs = 0;
        const make = () =>
          Effect.suspend(() => {
            runs += 1;
            return Deferred.await(latch).pipe(Effect.as('rotated'));
          });

        const first = yield* Effect.forkChild(attempt.run(make), {
          startImmediately: true,
        });
        const joiner = yield* Effect.forkChild(attempt.run(make), {
          startImmediately: true,
        });
        yield* Fiber.interrupt(first);
        yield* Deferred.succeed(latch, undefined);

        expect(yield* Fiber.join(joiner)).toBe('rotated');
        expect(runs).toBe(1);
        expect(attempt.inFlight).toBe(false);
      }),
  );
});
