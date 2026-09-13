// Third-party imports
import { it } from '@effect/vitest';
import { Deferred, Effect, Exit, Fiber, Scope } from 'effect';
import { TestClock } from 'effect/testing';
import { afterEach, beforeEach, describe, expect, vi, type Mock } from 'vitest';

// Local imports
import {
  ModelRetryGate,
  type RoutePolicy,
} from '@agent/runtime/ModelRetryGate';

const ROUTE = 'openai:subscription:gpt-5.6';
const MODEL_ROUTE = `${ROUTE}:model`;
const OTHER_MODEL_ROUTE = 'openai:subscription:gpt-5.7:model';
const TRANSIENT = new Error('temporary connection failure');
const RATE_LIMIT = Object.assign(new Error('model rate limited'), {
  status: 429,
});
const UNAUTHORIZED = Object.assign(new Error('credential expired'), {
  status: 401,
});

/** The default single wire route: every failure cools the shared route. */
function wireRoutes(
  classifyFailure: RoutePolicy['classifyFailure'] = () => ({}),
): [RoutePolicy] {
  return [{ key: ROUTE, classifyFailure }];
}

/** Run `attempt` through `gate` on `routes` with the test's base backoff. */
function gated<A, E>(
  gate: ModelRetryGate,
  routes: readonly [RoutePolicy, ...RoutePolicy[]],
  attempt: Effect.Effect<A, E>,
  baseBackoffMs = 1000,
): Effect.Effect<A, E> {
  return gate.withRoutes(routes, { baseBackoffMs })(attempt);
}

/** An attempt that succeeds at once and counts its admissions. */
function admitted(): { readonly attempt: Effect.Effect<void>; calls: Mock } {
  const calls = vi.fn();
  return { attempt: Effect.sync(calls), calls };
}

/**
 * Holds the gate's probe open: `started` completes when the gate admits the
 * attempt, and the attempt ends when `complete` or `fail` runs.
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
    fail: (error: Error) => Deferred.fail(ended, error),
  };
}

const openGate = (gate: ModelRetryGate) =>
  Effect.gen(function* () {
    expect(
      yield* Effect.flip(gated(gate, wireRoutes(), Effect.fail(TRANSIENT))),
    ).toBe(TRANSIENT);
  });

/** Asserts the forked call stays queued until exactly `delayMs` elapses. */
const expectAdmittedAfter = (
  pending: Fiber.Fiber<unknown, unknown>,
  calls: Mock,
  delayMs: number,
) =>
  Effect.gen(function* () {
    yield* TestClock.adjust(delayMs - 1);
    expect(calls).not.toHaveBeenCalled();
    yield* TestClock.adjust(1);
    yield* Fiber.join(pending);
    expect(calls).toHaveBeenCalledOnce();
  });

/** Recovers ROUTE with a successful probe after its base-backoff cooldown. */
const recoverRoute = (gate: ModelRetryGate) =>
  Effect.gen(function* () {
    const probe = yield* Effect.forkChild(
      gated(gate, wireRoutes(), Effect.void),
    );
    yield* TestClock.adjust(1000);
    yield* Fiber.join(probe);
  });

/** Fails ROUTE's recovery probe after the base-backoff cooldown. */
const failRecoveryProbe = (gate: ModelRetryGate) =>
  Effect.gen(function* () {
    const failedProbe = yield* Effect.forkChild(
      gated(gate, wireRoutes(), Effect.fail(TRANSIENT)),
    );
    yield* TestClock.adjust(1000);
    expect(yield* Effect.flip(Fiber.join(failedProbe))).toBe(TRANSIENT);
  });

describe('ModelRetryGate', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it.effect(
    'grows the shared backoff when the released herd re-fails after a probe',
    () =>
      Effect.gen(function* () {
        // Regression: resetting the failure streak on probe success capped the
        // backoff at its base forever on capacity-limited (429) routes — the
        // rate window fits one probe, the released herd re-fails, and the
        // counter restarts from zero every round.
        const gate = yield* ModelRetryGate.make;
        yield* openGate(gate);

        const probeAttempt = admitted();
        const probe = yield* Effect.forkChild(
          gated(gate, wireRoutes(), probeAttempt.attempt),
        );
        const herdAttempt = vi.fn(() => Effect.fail(TRANSIENT));
        const herd = yield* Effect.forkChild(
          gated(gate, wireRoutes(), Effect.suspend(herdAttempt)),
        );

        yield* TestClock.adjust(1000);
        yield* Fiber.join(probe);
        expect(yield* Effect.flip(Fiber.join(herd))).toBe(TRANSIENT);
        expect(probeAttempt.calls).toHaveBeenCalledOnce();
        expect(herdAttempt).toHaveBeenCalledOnce();

        // Second failure on the route: backoff must now be 2x the base.
        const nextAttempt = admitted();
        const next = yield* Effect.forkChild(
          gated(gate, wireRoutes(), nextAttempt.attempt),
        );
        yield* expectAdmittedAfter(next, nextAttempt.calls, 2000);

        // Third failure keeps growing: 4x the base.
        yield* openGate(gate);
        const finalAttempt = admitted();
        const final = yield* Effect.forkChild(
          gated(gate, wireRoutes(), finalAttempt.attempt),
        );
        yield* expectAdmittedAfter(final, finalAttempt.calls, 4000);
      }),
  );

  it.effect('keeps model rate limits off the shared wire route', () =>
    Effect.gen(function* () {
      const gate = yield* ModelRetryGate.make;
      const modelRoutes = (modelRoute: string): [RoutePolicy, RoutePolicy] => [
        {
          key: modelRoute,
          classifyFailure: (error) => (error === RATE_LIMIT ? {} : undefined),
        },
        {
          key: ROUTE,
          classifyFailure: () => undefined,
          isReachableFailure: (error) => error === RATE_LIMIT,
        },
      ];

      expect(
        yield* Effect.flip(
          gated(gate, modelRoutes(MODEL_ROUTE), Effect.fail(RATE_LIMIT)),
        ),
      ).toBe(RATE_LIMIT);

      const limitedAttempt = admitted();
      const limited = yield* Effect.forkChild(
        gated(gate, modelRoutes(MODEL_ROUTE), limitedAttempt.attempt),
      );
      const otherModelAttempt = admitted();
      yield* gated(
        gate,
        modelRoutes(OTHER_MODEL_ROUTE),
        otherModelAttempt.attempt,
      );

      expect(otherModelAttempt.calls).toHaveBeenCalledOnce();
      expect(limitedAttempt.calls).not.toHaveBeenCalled();
      yield* TestClock.adjust(1000);
      yield* Fiber.join(limited);
      expect(limitedAttempt.calls).toHaveBeenCalledOnce();
    }),
  );

  it.effect(
    'does not reserve the wire probe while waiting for a model cooldown',
    () =>
      Effect.gen(function* () {
        const gate = yield* ModelRetryGate.make;
        const modelRoutes = (
          modelRoute: string,
          modelRetryAfterMs?: number,
        ): [RoutePolicy, RoutePolicy] => [
          {
            key: modelRoute,
            classifyFailure: (error) =>
              error === RATE_LIMIT
                ? { retryAfterMs: modelRetryAfterMs }
                : undefined,
          },
          {
            key: ROUTE,
            classifyFailure: (error) => (error === TRANSIENT ? {} : undefined),
            isReachableFailure: (error) => error === RATE_LIMIT,
          },
        ];

        expect(
          yield* Effect.flip(
            gated(
              gate,
              modelRoutes(MODEL_ROUTE, 10_000),
              Effect.fail(RATE_LIMIT),
            ),
          ),
        ).toBe(RATE_LIMIT);
        expect(
          yield* Effect.flip(
            gated(gate, modelRoutes(OTHER_MODEL_ROUTE), Effect.fail(TRANSIENT)),
          ),
        ).toBe(TRANSIENT);

        const limitedAttempt = admitted();
        const limited = yield* Effect.forkChild(
          gated(gate, modelRoutes(MODEL_ROUTE, 10_000), limitedAttempt.attempt),
        );
        const siblingAttempt = admitted();
        const sibling = yield* Effect.forkChild(
          gated(gate, modelRoutes(OTHER_MODEL_ROUTE), siblingAttempt.attempt),
        );

        yield* TestClock.adjust(1000);
        yield* Fiber.join(sibling);
        expect(siblingAttempt.calls).toHaveBeenCalledOnce();
        expect(limitedAttempt.calls).not.toHaveBeenCalled();

        yield* TestClock.adjust(9000);
        yield* Fiber.join(limited);
        expect(limitedAttempt.calls).toHaveBeenCalledOnce();
      }),
  );

  it.effect(
    'ends the failure streak after a clean round-trip on the healthy route',
    () =>
      Effect.gen(function* () {
        const gate = yield* ModelRetryGate.make;
        yield* openGate(gate);

        // Recover the route via a successful probe (streak carries over)...
        yield* recoverRoute(gate);

        // ...then a success admitted while the route is already healthy resets it.
        yield* gated(gate, wireRoutes(), Effect.void);
        yield* openGate(gate);

        // Cooling restarts at the base backoff, not the previous streak's tier.
        const nextAttempt = admitted();
        const next = yield* Effect.forkChild(
          gated(gate, wireRoutes(), nextAttempt.attempt),
        );
        yield* TestClock.adjust(1000);
        yield* Fiber.join(next);
        expect(nextAttempt.calls).toHaveBeenCalledOnce();
      }),
  );

  it.effect('honors an explicitly disabled shared backoff', () =>
    Effect.gen(function* () {
      const gate = yield* ModelRetryGate.make;
      expect(
        yield* Effect.flip(
          gated(gate, wireRoutes(), Effect.fail(TRANSIENT), 0),
        ),
      ).toBe(TRANSIENT);

      const retryAttempt = admitted();
      const retry = yield* Effect.forkChild(
        gated(gate, wireRoutes(), retryAttempt.attempt, 0),
      );
      expect(retryAttempt.calls).not.toHaveBeenCalled();
      yield* TestClock.adjust(0);
      yield* Fiber.join(retry);
      expect(retryAttempt.calls).toHaveBeenCalledOnce();
    }),
  );

  it.effect('increases the shared backoff after a failed probe', () =>
    Effect.gen(function* () {
      const gate = yield* ModelRetryGate.make;
      yield* openGate(gate);
      yield* failRecoveryProbe(gate);

      const nextAttempt = admitted();
      const next = yield* Effect.forkChild(
        gated(gate, wireRoutes(), nextAttempt.attempt),
      );
      yield* expectAdmittedAfter(next, nextAttempt.calls, 2000);
    }),
  );

  it.effect('keeps peers queued after an unclassified probe failure', () =>
    Effect.gen(function* () {
      const gate = yield* ModelRetryGate.make;
      yield* openGate(gate);

      const probe = pendingAttempt();
      const failedProbe = yield* Effect.forkChild(
        gated(
          gate,
          wireRoutes((error) => (error === TRANSIENT ? {} : undefined)),
          probe.attempt,
        ),
      );
      const firstPeerAttempt = admitted();
      const firstPeer = yield* Effect.forkChild(
        gated(gate, wireRoutes(), firstPeerAttempt.attempt),
      );
      const secondPeerAttempt = admitted();
      const secondPeer = yield* Effect.forkChild(
        gated(gate, wireRoutes(), secondPeerAttempt.attempt),
      );

      yield* TestClock.adjust(1000);
      yield* probe.started;
      yield* probe.fail(UNAUTHORIZED);
      expect(yield* Effect.flip(Fiber.join(failedProbe))).toBe(UNAUTHORIZED);
      expect(firstPeerAttempt.calls).not.toHaveBeenCalled();
      expect(secondPeerAttempt.calls).not.toHaveBeenCalled();

      yield* TestClock.adjust(0);
      yield* Fiber.join(firstPeer);
      yield* Fiber.join(secondPeer);
      expect(firstPeerAttempt.calls).toHaveBeenCalledOnce();
      expect(secondPeerAttempt.calls).toHaveBeenCalledOnce();
    }),
  );

  it.effect(
    'resets an old failure streak after a healthy unclassified failure',
    () =>
      Effect.gen(function* () {
        const gate = yield* ModelRetryGate.make;
        yield* openGate(gate);
        const scopedRoutes = wireRoutes((error) =>
          error === TRANSIENT ? {} : undefined,
        );

        const probe = yield* Effect.forkChild(
          gated(gate, scopedRoutes, Effect.void),
        );
        const healthyFailure = yield* Effect.forkChild(
          gated(gate, scopedRoutes, Effect.fail(UNAUTHORIZED)),
        );
        yield* TestClock.adjust(1000);
        yield* Fiber.join(probe);
        expect(yield* Effect.flip(Fiber.join(healthyFailure))).toBe(
          UNAUTHORIZED,
        );

        expect(
          yield* Effect.flip(gated(gate, scopedRoutes, Effect.fail(TRANSIENT))),
        ).toBe(TRANSIENT);
        const recoveredAttempt = admitted();
        const recovered = yield* Effect.forkChild(
          gated(gate, scopedRoutes, recoveredAttempt.attempt),
        );
        yield* expectAdmittedAfter(recovered, recoveredAttempt.calls, 1000);
      }),
  );

  it.effect('does not let a stale success erase a newer failed probe', () =>
    Effect.gen(function* () {
      const gate = yield* ModelRetryGate.make;
      const stale = pendingAttempt();
      const stalePending = yield* Effect.forkChild(
        gated(gate, wireRoutes(), stale.attempt),
      );
      yield* stale.started;
      yield* openGate(gate);
      yield* failRecoveryProbe(gate);

      const currentAttempt = admitted();
      const current = yield* Effect.forkChild(
        gated(gate, wireRoutes(), currentAttempt.attempt),
      );
      yield* stale.complete;
      yield* Fiber.join(stalePending);
      yield* expectAdmittedAfter(current, currentAttempt.calls, 2000);
    }),
  );

  it.effect(
    'does not let a stale healthy success reset recovered backoff',
    () =>
      Effect.gen(function* () {
        const gate = yield* ModelRetryGate.make;
        const stale = pendingAttempt();
        const stalePending = yield* Effect.forkChild(
          gated(gate, wireRoutes(), stale.attempt),
        );
        yield* stale.started;
        yield* openGate(gate);
        yield* recoverRoute(gate);

        yield* stale.complete;
        yield* Fiber.join(stalePending);
        yield* openGate(gate);

        const nextAttempt = admitted();
        const next = yield* Effect.forkChild(
          gated(gate, wireRoutes(), nextAttempt.attempt),
        );
        yield* expectAdmittedAfter(next, nextAttempt.calls, 2000);
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
      expect(Exit.hasInterrupts(yield* Fiber.await(first))).toBe(true);
      yield* Fiber.join(next);
      expect(nextAttempt.calls).toHaveBeenCalledOnce();
    }),
  );

  it.effect('interrupts calls waiting when the session scope closes', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const gate = yield* ModelRetryGate.make.pipe(Scope.provide(scope));
      yield* openGate(gate);

      const waitingAttempt = admitted();
      const waiting = yield* Effect.forkChild(
        gated(gate, wireRoutes(), waitingAttempt.attempt),
      );
      yield* TestClock.adjust(0);
      yield* Scope.close(scope, Exit.void);

      expect(Exit.hasInterrupts(yield* Fiber.await(waiting))).toBe(true);
      expect(waitingAttempt.calls).not.toHaveBeenCalled();
    }),
  );

  it.effect(
    'frees the cooldown probe when its final waiter is interrupted',
    () =>
      Effect.gen(function* () {
        const gate = yield* ModelRetryGate.make;
        yield* openGate(gate);
        const waiting = yield* Effect.forkChild(
          gated(gate, wireRoutes(), Effect.void),
        );
        yield* TestClock.adjust(400);
        yield* Fiber.interrupt(waiting);
        expect(Exit.hasInterrupts(yield* Fiber.await(waiting))).toBe(true);

        // The next call schedules its own probe for the rest of the cooldown;
        // a probe slot the interrupted waiter left occupied would never admit it.
        const nextAttempt = admitted();
        const next = yield* Effect.forkChild(
          gated(gate, wireRoutes(), nextAttempt.attempt),
        );
        yield* expectAdmittedAfter(next, nextAttempt.calls, 600);
      }),
  );
});
