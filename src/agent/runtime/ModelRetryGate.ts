import { Cause, Clock, Deferred, Effect, Exit, Fiber, Scope } from 'effect';

import { jitteredExponentialBackoffMs } from '@utils/core';
import { ensureError } from '@utils/errors/errorMessage';

const MAX_BACKOFF_MS = 5 * 60 * 1000;

type RoutePhase = 'healthy' | 'cooling' | 'probing';

interface RetryPermit {
  readonly version: number;
  readonly probe: boolean;
}

/** One call waiting on a route; it leaves the queue when its fiber is interrupted. */
interface Waiter {
  readonly permit: Deferred.Deferred<RetryPermit>;
  /**
   * The permit the gate handed this waiter, recorded before `permit`
   * completes: an interruption landing between the grant and the waiter
   * resuming still returns a probe to the cohort instead of losing it.
   */
  granted: RetryPermit | undefined;
}

/**
 * One scheduled probe. The slot is taken before the fiber exists, so a
 * probe that completes during its own fork still clears it, and a stale
 * fiber recognizes it was superseded.
 */
interface ScheduledProbe {
  fiber: Fiber.Fiber<void> | undefined;
}

interface RouteState {
  version: number;
  phase: RoutePhase;
  failures: number;
  retryAt: number;
  probe: ScheduledProbe | undefined;
  readonly waiters: Waiter[];
}

interface RouteFailure {
  readonly retryAfterMs?: number;
}

export interface RoutePolicy {
  readonly key: string;
  readonly classifyFailure: (error: Error) => RouteFailure | undefined;
  readonly isReachableFailure?: (error: Error) => boolean;
}

interface RouteOptions {
  readonly baseBackoffMs: number;
  readonly onWait?: (delayMs: number) => void;
}

interface AcquiredRoute extends RoutePolicy {
  readonly permit: RetryPermit;
}

/**
 * Coordinates retries for model calls sharing one provider route.
 *
 * Healthy routes remain fully concurrent. After a shared-route failure, calls
 * on the affected route wait through one shared backoff and exactly one
 * becomes the recovery probe. A successful probe releases the other calls;
 * another route failure increases the shared backoff. The gate does not decide
 * how many times a node retries—that remains the node retry loop's concern.
 *
 * Route state is mutated only from within Effect steps on one runtime, so a
 * plain map is atomic here; the probe timer is a fiber in the gate's scope
 * that sleeps on the runtime `Clock`, and a waiting call is a `Deferred` the
 * probe fiber or a healthy success completes.
 */
export class ModelRetryGate {
  /**
   * Build the gate in a scope: its probe fibers die with the scope, and
   * every call still waiting on a permit when it closes is interrupted.
   */
  static readonly make: Effect.Effect<ModelRetryGate, never, Scope.Scope> =
    Effect.gen(function* () {
      const gate = new ModelRetryGate(yield* Effect.scope);
      yield* Effect.addFinalizer(() => gate.close());
      return gate;
    });

  private readonly routes = new Map<string, RouteState>();
  private closed = false;

  private constructor(private readonly scope: Scope.Scope) {}

  /**
   * Run `attempt` gated on every route in `routes`, narrowest first (see
   * {@link acquireAll}), then record what its exit proved about them: a
   * success marks every route reachable, an interruption hands the permits
   * back, a failure is classified per route. The tuple type is non-empty
   * because an empty list would run the attempt entirely ungated.
   */
  withRoutes(
    routes: readonly [RoutePolicy, ...RoutePolicy[]],
    options: RouteOptions,
  ): <A, E, R>(attempt: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R> {
    return (attempt) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen({ self: this }, function* () {
          const acquired = yield* restore(
            this.acquireAll(routes, options.onWait),
          );
          const exit = yield* Effect.exit(restore(attempt));
          yield* this.settle(acquired, exit, options.baseBackoffMs);
          return yield* exit;
        }),
      );
  }

  private settle(
    acquired: readonly AcquiredRoute[],
    exit: Exit.Exit<unknown, unknown>,
    baseBackoffMs: number,
  ): Effect.Effect<void> {
    if (Exit.isSuccess(exit)) {
      return Effect.forEach(
        acquired,
        (entry) => this.markReachable(entry.key, entry.permit),
        { discard: true },
      );
    }
    if (Cause.hasInterrupts(exit.cause)) return this.abandonAll(acquired);
    const error = ensureError(Cause.squash(exit.cause));
    return Effect.forEach(
      acquired,
      (entry) => {
        const failure = entry.classifyFailure(error);
        if (failure) {
          return this.markRouteFailure(
            entry.key,
            entry.permit,
            baseBackoffMs,
            failure,
          );
        }
        if (entry.isReachableFailure?.(error)) {
          return this.markReachable(entry.key, entry.permit);
        }
        if (entry.permit.probe) {
          // An unclassified failure does not prove that a recovering route is
          // reachable. Keep the cohort closed and hand probe ownership to one
          // waiter; shared credential failures can otherwise release every
          // peer before their out-of-gate recovery finishes.
          return this.abandon(entry.key, entry.permit);
        }
        // A current healthy permit reached the operation boundary. Even when
        // its error is local to that request, it proves that an older
        // shared-route failure streak no longer describes this route.
        return this.markReachable(entry.key, entry.permit);
      },
      { discard: true },
    );
  }

  /**
   * Acquires narrower additional scopes before the primary route. A
   * model-specific probe may wait for its shared wire route without blocking
   * healthy sibling models. A later wait can also make an earlier permit
   * stale, so validate the complete set before sending. An interruption while
   * waiting hands every permit already held back.
   */
  private acquireAll(
    routes: readonly RoutePolicy[],
    onWait: RouteOptions['onWait'],
  ): Effect.Effect<AcquiredRoute[]> {
    const held: AcquiredRoute[] = [];
    return Effect.gen({ self: this }, function* () {
      while (true) {
        for (const route of routes) {
          held.push({
            ...route,
            permit: yield* this.acquire(route.key, onWait),
          });
        }
        if (
          held.every((entry) => this.isCurrentPermit(entry.key, entry.permit))
        ) {
          return held.splice(0);
        }
        yield* this.abandonAll(held.splice(0));
      }
    }).pipe(Effect.onInterrupt(() => this.abandonAll(held.splice(0))));
  }

  private isCurrentPermit(route: string, permit: RetryPermit): boolean {
    const state = this.routes.get(route);
    if (!state || permit.version !== state.version) return false;
    return permit.probe ? state.phase === 'probing' : state.phase === 'healthy';
  }

  /** Interrupt every call still waiting; the scope interrupts the probe fibers. */
  private close(): Effect.Effect<void> {
    return Effect.suspend(() => {
      this.closed = true;
      const waiting = [...this.routes.values()].flatMap((state) =>
        state.waiters.splice(0),
      );
      this.routes.clear();
      return Effect.forEach(
        waiting,
        (waiter) => Deferred.interrupt(waiter.permit),
        { discard: true },
      );
    });
  }

  /**
   * A healthy route admits immediately. Otherwise the call joins the route's
   * waiters until the probe fiber picks it or a success releases the cohort;
   * joining and waiting are one uninterruptible step, so an interruption
   * always finds the waiter registered and removes it.
   */
  private acquire(
    route: string,
    onWait: RouteOptions['onWait'],
  ): Effect.Effect<RetryPermit> {
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen({ self: this }, function* () {
        if (this.closed) return yield* Effect.interrupt;
        const healthyPermit = this.acquireHealthy(route);
        if (healthyPermit) return healthyPermit;
        // Safe: acquireHealthy only returns undefined when it found an
        // existing, non-healthy state for `route` (the create-on-miss branch
        // always returns a permit), so the state it read is still in the map.
        const state = this.routes.get(route)!;

        const now = yield* Clock.currentTimeMillis;
        onWait?.(Math.max(0, state.retryAt - now));
        const waiter: Waiter = {
          permit: Deferred.makeUnsafe<RetryPermit>(),
          granted: undefined,
        };
        state.waiters.push(waiter);
        yield* this.scheduleProbe(state);
        return yield* restore(Deferred.await(waiter.permit)).pipe(
          Effect.onInterrupt(() => this.leave(state, waiter)),
        );
      }),
    );
  }

  /** The interrupted waiter leaves its route; a probe it was granted moves on. */
  private leave(state: RouteState, waiter: Waiter): Effect.Effect<void> {
    return Effect.suspend(() => {
      const index = state.waiters.indexOf(waiter);
      if (index >= 0) state.waiters.splice(index, 1);
      if (waiter.granted?.probe) {
        return this.abandonRoute(state, waiter.granted);
      }
      return state.waiters.length === 0 ? this.cancelProbe(state) : Effect.void;
    });
  }

  private acquireHealthy(route: string): RetryPermit | undefined {
    const state = this.routes.get(route);
    if (state && state.phase !== 'healthy') return undefined;
    const healthyState = state ?? {
      version: 0,
      phase: 'healthy' as const,
      failures: 0,
      retryAt: 0,
      probe: undefined,
      waiters: [],
    };
    this.routes.set(route, healthyState);
    return {
      version: healthyState.version,
      probe: false,
    };
  }

  private markRouteFailure(
    route: string,
    permit: RetryPermit,
    baseBackoffMs: number,
    failure: RouteFailure,
  ): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const state = this.routes.get(route);
      if (!state || permit.version !== state.version) return;
      if (state.phase !== 'healthy' && !permit.probe) return;

      state.version += 1;
      state.phase = 'cooling';
      state.failures += 1;
      state.retryAt =
        (yield* Clock.currentTimeMillis) +
        Math.max(
          jitteredExponentialBackoffMs(
            baseBackoffMs,
            state.failures,
            MAX_BACKOFF_MS,
          ),
          failure.retryAfterMs ?? 0,
        );
      yield* this.scheduleProbe(state);
    });
  }

  private markReachable(
    route: string,
    permit: RetryPermit,
  ): Effect.Effect<void> {
    return Effect.suspend(() => {
      const state = this.routes.get(route);
      if (!state) return Effect.void;
      if (state.phase === 'healthy') {
        // A success admitted while the route was already healthy proves a
        // clean round-trip, so the failure streak ends here — not on probe
        // success, whose released cohort may immediately re-fail (a rate
        // window that fits one probe rarely fits the herd). Resetting on probe
        // success would cap the shared backoff at its base forever in exactly
        // that cycle.
        if (permit.version === state.version) {
          state.failures = 0;
        }
        return Effect.void;
      }
      if (permit.version !== state.version) return Effect.void;
      if (state.phase === 'probing' && !permit.probe) return Effect.void;

      state.version += 1;
      state.phase = 'healthy';
      state.retryAt = 0;
      const released: RetryPermit = { version: state.version, probe: false };
      const waiting = state.waiters.splice(0);
      return this.cancelProbe(state).pipe(
        Effect.andThen(
          Effect.forEach(
            waiting,
            (waiter) => {
              waiter.granted = released;
              return Deferred.succeed(waiter.permit, released);
            },
            { discard: true },
          ),
        ),
      );
    });
  }

  private abandonAll(acquired: readonly AcquiredRoute[]): Effect.Effect<void> {
    return Effect.forEach(
      acquired,
      (entry) => this.abandon(entry.key, entry.permit),
      { discard: true },
    );
  }

  private abandon(route: string, permit: RetryPermit): Effect.Effect<void> {
    return Effect.suspend(() => {
      const state = this.routes.get(route);
      return state ? this.abandonRoute(state, permit) : Effect.void;
    });
  }

  /** An unused probe permit reopens cooling so the next waiter probes at once. */
  private abandonRoute(
    state: RouteState,
    permit: RetryPermit,
  ): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      if (
        !permit.probe ||
        permit.version !== state.version ||
        state.phase !== 'probing'
      ) {
        return;
      }
      state.phase = 'cooling';
      state.retryAt = yield* Clock.currentTimeMillis;
      yield* this.scheduleProbe(state);
    });
  }

  private cancelProbe(state: RouteState): Effect.Effect<void> {
    const probe = state.probe;
    state.probe = undefined;
    return probe?.fiber ? Fiber.interrupt(probe.fiber) : Effect.void;
  }

  /**
   * Fork the route's one probe fiber into the gate's scope: it sleeps until
   * `retryAt` on the runtime clock, then hands the probe permit to the
   * oldest waiter still queued.
   */
  private scheduleProbe(state: RouteState): Effect.Effect<void> {
    if (
      state.phase !== 'cooling' ||
      state.probe ||
      state.waiters.length === 0
    ) {
      return Effect.void;
    }
    const scheduled: ScheduledProbe = { fiber: undefined };
    state.probe = scheduled;
    const probe = Effect.gen(function* () {
      // A probe handed on by an abandoning holder is due now: grant it on
      // this fiber's first step rather than through a zero-length sleep.
      const delayMs = state.retryAt - (yield* Clock.currentTimeMillis);
      if (delayMs > 0) yield* Effect.sleep(delayMs);
      if (state.probe !== scheduled) return;
      state.probe = undefined;
      if (state.phase !== 'cooling') return;
      const waiter = state.waiters.shift();
      if (!waiter) return;
      state.phase = 'probing';
      waiter.granted = { version: state.version, probe: true };
      yield* Deferred.succeed(waiter.permit, waiter.granted);
    });
    return Effect.forkIn(probe, this.scope).pipe(
      Effect.map((fiber) => {
        scheduled.fiber = fiber;
      }),
    );
  }
}
