import { it } from '@effect/vitest';
import { Cause, Effect, Exit, Fiber, Ref } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect } from 'vitest';

import {
  DeviceAuthorizationPending,
  pollDeviceAuthorization,
} from '@auth/oauth/deviceAuthorization';

/** The failure an exit carries, or undefined when it succeeded. */
const failureOf = (exit: Exit.Exit<unknown, unknown>): unknown =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

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
  it.effect('returns the authorized value after soft continues', () =>
    Effect.gen(function* () {
      const { poll, attempts } = queuedPoll(['pending', 'pending', 'token']);
      const fiber = yield* Effect.forkChild(
        pollDeviceAuthorization({
          poll,
          intervalMs: 1000,
          expiresInMs: 10_000,
        }),
      );

      yield* TestClock.adjust('2999 millis');
      expect(yield* attempts).toBe(2);
      yield* TestClock.adjust('1 millis');

      expect(yield* Fiber.join(fiber)).toBe('token');
      expect(yield* attempts).toBe(3);
    }),
  );

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

  it.effect('times out at the deadline instead of waiting once more', () =>
    Effect.gen(function* () {
      const { poll, attempts } = queuedPoll(['pending', 'pending', 'pending']);
      const fiber = yield* Effect.forkChild(
        pollDeviceAuthorization({
          poll,
          intervalMs: 5000,
          expiresInMs: 10_000,
        }),
      );

      // t=5 poll; t=10 is the deadline: no third wait, no third poll.
      yield* TestClock.adjust('10 seconds');

      expect(failureOf(yield* Fiber.await(fiber))).toMatchObject({
        _tag: 'DeviceCodeTimedOut',
      });
      expect(yield* attempts).toBe(1);
    }),
  );

  it.effect('never starts a poll past the deadline', () =>
    Effect.gen(function* () {
      const { poll, attempts } = queuedPoll(['pending']);
      const fiber = yield* Effect.forkChild(
        pollDeviceAuthorization({ poll, intervalMs: 5000, expiresInMs: 4000 }),
      );

      yield* TestClock.adjust('5 seconds');

      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(yield* attempts).toBe(0);
    }),
  );

  it.effect('propagates hard errors from the poll', () =>
    Effect.gen(function* () {
      const { poll } = queuedPoll([new Error('access_denied')]);
      const fiber = yield* Effect.forkChild(
        pollDeviceAuthorization({
          poll,
          intervalMs: 1000,
          expiresInMs: 10_000,
        }),
      );

      yield* TestClock.adjust('1 second');

      expect(failureOf(yield* Fiber.await(fiber))).toEqual(
        new Error('access_denied'),
      );
    }),
  );

  it.effect('interruption during the first wait skips the poll', () =>
    Effect.gen(function* () {
      const { poll, attempts } = queuedPoll(['token']);
      const fiber = yield* Effect.forkChild(
        pollDeviceAuthorization({
          poll,
          intervalMs: 1000,
          expiresInMs: 60_000,
        }),
      );

      yield* Fiber.interrupt(fiber);

      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(
        true,
      );
      expect(yield* attempts).toBe(0);
    }),
  );
});
