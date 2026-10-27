// Third-party imports
import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Random } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, vi, type Mock } from 'vitest';

// Local imports
import {
  ModelRetryGate,
  type RoutePolicy,
} from '@agent/runtime/ModelRetryGate';

const ROUTE = 'openai:subscription:gpt-5.6';
const TRANSIENT = new Error('temporary connection failure');

/** The default single wire route: every failure cools the shared route. */
function wireRoutes(): [RoutePolicy] {
  return [{ key: ROUTE, classifyFailure: () => ({}) }];
}

/** A draw at the middle of [0, 1): the ±20 % jitter scales by exactly 1. */
const MIDPOINT_RANDOM: Random.Random = {
  nextDoubleUnsafe: () => 0.5,
  nextIntUnsafe: () => 0,
};

/** Run `attempt` through `gate` on `routes` with a 1s base backoff and a
 *  jitter-free cooldown. */
function gated<A, E>(
  gate: ModelRetryGate,
  routes: readonly [RoutePolicy, ...RoutePolicy[]],
  attempt: Effect.Effect<A, E>,
): Effect.Effect<A, E> {
  return gate
    .withRoutes(routes, { baseBackoffMs: 1000 })(attempt)
    .pipe(Effect.provideService(Random.Random, MIDPOINT_RANDOM));
}

/** An attempt that succeeds at once and counts its admissions. */
function admitted(): { readonly attempt: Effect.Effect<void>; calls: Mock } {
  const calls = vi.fn();
  return { attempt: Effect.sync(calls), calls };
}

/**
 * Holds the gate's probe open: `started` completes when the gate admits the
 * attempt, and the attempt ends when `complete` runs.
 */
function pendingAttempt() {
  const started = Deferred.makeUnsafe<void>();
  const ended = Deferred.makeUnsafe<void, Error>();
  const calls = vi.fn();
  return {
    calls,
    attempt: Effect.suspend(() => {
      calls();
      return Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(ended)),
      );
    }),
    started: Deferred.await(started),
    complete: Deferred.succeed(ended, undefined),
  };
}

const openGate = (gate: ModelRetryGate) =>
  Effect.gen(function* () {
    expect(
      yield* Effect.flip(gated(gate, wireRoutes(), Effect.fail(TRANSIENT))),
    ).toBe(TRANSIENT);
  });

describe('ModelRetryGate', () => {
  it.effect(
    'admits one recovery probe and releases siblings after success',
    () =>
      Effect.gen(function* () {
        const gate = yield* ModelRetryGate.make;
        yield* openGate(gate);

        const probe = pendingAttempt();
        const sibling = admitted();
        const first = yield* Effect.forkChild(
          gated(gate, wireRoutes(), probe.attempt),
        );
        const second = yield* Effect.forkChild(
          gated(gate, wireRoutes(), sibling.attempt),
        );

        yield* TestClock.adjust(1000);
        yield* probe.started;
        expect(probe.calls).toHaveBeenCalledOnce();
        expect(sibling.calls).not.toHaveBeenCalled();

        yield* probe.complete;
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        expect(sibling.calls).toHaveBeenCalledOnce();
      }),
  );

  it.effect('hands an abandoned probe to the next waiting call', () =>
    Effect.gen(function* () {
      const gate = yield* ModelRetryGate.make;
      yield* openGate(gate);

      const probe = pendingAttempt();
      const first = yield* Effect.forkChild(
        gated(gate, wireRoutes(), probe.attempt),
      );
      const nextAttempt = admitted();
      const next = yield* Effect.forkChild(
        gated(gate, wireRoutes(), nextAttempt.attempt),
      );

      yield* TestClock.adjust(1000);
      yield* probe.started;
      yield* Fiber.interrupt(first);
      yield* Fiber.join(next);
      expect(nextAttempt.calls).toHaveBeenCalledOnce();
    }),
  );
});
