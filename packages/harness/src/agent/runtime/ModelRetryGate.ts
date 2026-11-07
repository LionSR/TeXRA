/**
 * The process's model retry gate. A failure llm scoped to a route cools that
 * route for every call on it, across every run of every project: the calls
 * wait out one shared backoff, one of them goes through as the recovery
 * probe, and its success opens the route to the rest. A healthy route admits
 * every call at once. How many times a call is resent is its loop's
 * business, not the gate's.
 */
import {
  Cause,
  Clock,
  Context,
  Effect,
  Exit,
  Latch,
  Random,
  Semaphore,
} from 'effect';
import { ModelError } from '@texra-ai/llm';

import { jitteredExponentialBackoffMs } from '@utils/core';

/** Base delay between automatic resends; the gate doubles it per failure of
 *  a cooling route, and a loop waits it out after a failure no route owns. */
const RETRY_BACKOFF_MS = 1000;

const MAX_BACKOFF_MS = 5 * 60 * 1000;

/** One route a binding's calls go through: its key, and the scope of the
 *  failures that cool it (llm's `ModelError.scope`). */
export interface RoutePolicy {
  readonly key: string;
  readonly scope: 'model' | 'route';
}

/** Gate `attempt` on every route in `routes`, narrowest first. The tuple is
 *  non-empty because an empty list would run the attempt ungated. */
export interface ModelRetryGate {
  readonly withRoutes: (
    routes: readonly [RoutePolicy, ...RoutePolicy[]],
  ) => <A, E, R>(attempt: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

/** The process's one retry gate, served by `processLayer`: a 429 cools a
 *  credential for every run of every project. */
export class RouteRetries extends Context.Service<
  RouteRetries,
  ModelRetryGate
>()('@texra-ai/harness/RouteRetries') {}

interface Route {
  /** Open while the route is healthy; a cooling route's calls wait on it. */
  readonly healthy: Latch.Latch;
  /** The one recovery probe a cooling route lets through at a time. Only
   *  its holder opens `healthy`. */
  readonly probe: Semaphore.Semaphore;
  /** Failures since the last success admitted while healthy. */
  failures: number;
  /** When the cooling route's next probe may go. */
  retryAt: number;
}

/** How a call went through one route: with the healthy cohort, or as the
 *  probe that holds the route's permit. */
type Pass = 'healthy' | 'probe';

/**
 * Admit a call to `route`: at once while it is healthy; otherwise when the
 * route opens, or as its probe once the backoff has passed. Taking the permit
 * and waiting out the backoff are one interruptible wait, and an interruption
 * hands the permit back.
 */
const admit = (route: Route): Effect.Effect<Pass> =>
  Effect.suspend(() =>
    route.healthy.isOpen()
      ? Effect.succeed<Pass>('healthy')
      : Effect.raceFirst(
          Effect.as(route.healthy.await, 'healthy' as const),
          Effect.uninterruptibleMask((restore) =>
            restore(route.probe.take(1)).pipe(
              Effect.andThen(
                restore(
                  Effect.gen(function* () {
                    const delayMs =
                      route.retryAt - (yield* Clock.currentTimeMillis);
                    if (delayMs > 0) {
                      yield* Effect.logDebug(
                        `Waiting ${delayMs}ms for the model recovery probe.`,
                      );
                      yield* Effect.sleep(delayMs);
                    }
                    return 'probe' as const;
                  }),
                ).pipe(Effect.onInterrupt(() => route.probe.release(1))),
              ),
            ),
          ),
        ),
  );

/**
 * Record what a call's exit proved about one route it went through. A failure
 * scoped to the route cools it (a healthy route, or the probe's failure: a
 * call admitted before the route cooled says nothing new); any other end of
 * the probe opens it; a success, or a failure of the request alone, of a call
 * admitted while healthy ends the failure streak.
 */
const settle = (
  route: Route,
  { scope }: RoutePolicy,
  pass: Pass,
  exit: Exit.Exit<unknown, unknown>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const released = pass === 'probe' ? route.probe.release(1) : Effect.void;
    if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause))
      return yield* released;
    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
    if (error instanceof ModelError && error.scope === scope) {
      if (pass === 'probe' || route.healthy.isOpen()) {
        route.failures += 1;
        route.retryAt =
          (yield* Clock.currentTimeMillis) +
          Math.max(
            jitteredExponentialBackoffMs(
              RETRY_BACKOFF_MS,
              route.failures,
              MAX_BACKOFF_MS,
              yield* Random.next,
            ),
            error.retryAfterMs ?? 0,
          );
        yield* route.healthy.close;
      }
      return yield* released;
    }
    // A success admitted while healthy proves a clean round trip, so the
    // streak ends here, not on the probe's success: the cohort it releases
    // may fail again at once (a rate window that fits one probe rarely fits
    // the herd), and resetting there would hold the backoff at its base.
    if (pass === 'probe') yield* route.healthy.open;
    else if (route.healthy.isOpen()) route.failures = 0;
    yield* released;
  });

/**
 * The pause a loop takes before an automatic resend after `error`: as long as
 * the provider asked (`retryAfterMs`), else the base backoff; none for a
 * failure llm scoped to a route, which the gate cooled and waits out before
 * the next send.
 */
export const resendDelayMs = (error: unknown): number => {
  if (!(error instanceof ModelError)) return RETRY_BACKOFF_MS;
  return error.scope !== undefined
    ? 0
    : (error.retryAfterMs ?? RETRY_BACKOFF_MS);
};

/** A gate with every route healthy. */
export const makeRetryGate = (): ModelRetryGate => {
  const routes = new Map<string, Route>();
  const routeOf = (key: string): Route => {
    const existing = routes.get(key);
    if (existing !== undefined) return existing;
    const created: Route = {
      healthy: Latch.makeUnsafe(true),
      probe: Semaphore.makeUnsafe(1),
      failures: 0,
      retryAt: 0,
    };
    routes.set(key, created);
    return created;
  };
  return {
    withRoutes: (policies) => (attempt) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const passed: [Route, RoutePolicy, Pass][] = [];
          const exit = yield* Effect.exit(
            restore(
              Effect.gen(function* () {
                for (;;) {
                  for (const policy of policies) {
                    const route = routeOf(policy.key);
                    passed.push([route, policy, yield* admit(route)]);
                  }
                  // A route passed healthy may have cooled while a later one
                  // was waited on: hand back the probes held and wait again,
                  // so no call goes out inside a cooldown it was admitted
                  // before.
                  if (
                    passed.every(
                      ([route, , pass]) =>
                        pass === 'probe' || route.healthy.isOpen(),
                    )
                  )
                    return yield* attempt;
                  yield* Effect.uninterruptible(
                    Effect.suspend(() =>
                      Effect.forEach(
                        passed.splice(0),
                        ([route, , pass]) =>
                          pass === 'probe'
                            ? route.probe.release(1)
                            : Effect.void,
                        { discard: true },
                      ),
                    ),
                  );
                }
              }),
            ),
          );
          yield* Effect.forEach(
            passed,
            ([route, policy, pass]) => settle(route, policy, pass, exit),
            { discard: true },
          );
          return yield* exit;
        }),
      ),
  };
};
