import { it } from '@effect/vitest';
import { Effect, Fiber, Ref } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect } from 'vitest';

import {
  DeviceAuthorizationPending,
  pollDeviceAuthorization,
} from '../../../packages/llm/src/oauth/deviceAuthorization.js';

/** A poll that answers from a queue: `'pending'`, `'slow_down'`, a value, or an Error. */
function queuedPoll<T>(queue: Array<'pending' | 'slow_down' | T | Error>) {
  const attempts = Ref.makeUnsafe(0);
  const poll = Effect.gen(function* () {
    yield* Ref.update(attempts, (n) => n + 1);
    const next = queue.shift();
    if (next === undefined) throw new Error('queuedPoll ran out of answers');
    if (next === 'pending' || next === 'slow_down') {
      return yield* new DeviceAuthorizationPending({
        slowDown: next === 'slow_down',
      });
    }
    if (next instanceof Error) return yield* Effect.fail(next);
    return next;
  });
  return { poll, attempts: Ref.get(attempts) };
}

describe('pollDeviceAuthorization', () => {
  it.effect('grows the interval on slow_down', () =>
    Effect.gen(function* () {
      const { poll, attempts } = queuedPoll(['pending', 'slow_down', true]);
      const fiber = yield* Effect.forkChild(
        pollDeviceAuthorization({
          poll,
          intervalMs: 5000,
          expiresInMs: 60_000,
          slowDownIncrementMs: 5000,
        }),
      );

      // 5s, 5s, then 10s after the slow_down bump.
      yield* TestClock.adjust('10 seconds');
      expect(yield* attempts).toBe(2);
      yield* TestClock.adjust('9999 millis');
      expect(yield* attempts).toBe(2);
      yield* TestClock.adjust('1 millis');

      expect(yield* Fiber.join(fiber)).toBe(true);
    }),
  );
});
