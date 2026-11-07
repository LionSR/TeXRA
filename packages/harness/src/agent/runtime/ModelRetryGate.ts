/**
 * The process's model retry gate. A failure llm scoped to a route cools that
 * route for every call on it, across every run of every project: the calls
 * wait out one shared backoff, one of them goes through as the recovery
 * probe, and its success opens the route to the rest. A healthy route admits
 * every call at once. How many times a call is resent is its loop's
 * business, not the gate's.
 */
import { Cause, Clock, Context, Effect, Exit, Random, Semaphore } from 'effect';
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
  /** Whether the route admits every call at once. Only the holder of
   *  `probe` changes it while the route cools. */
  healthy: boolean;
  /** The one recovery probe a cooling route lets through at a time; a
   *  cooling route's calls queue on it. */
  readonly probe: Semaphore.Semaphore;
  /** Failures since the last success admitted while healthy. */
  failures: number;
  /** When the cooling route's next probe may go. */
  retryAt: number;
}

/** How a call went through one route: with the healthy cohort, or as the
 *  probe that holds the route's permit. */
type Pass = 'healthy' | 'probe';

/** A route passed healthy cooled while a later one was waited on. */
const COOLED = Symbol('cooled');

/** A gated call's end: the attempt's exit, or `COOLED` to wait again. */
type Through<A, E> = Exit.Exit<A, E> | typeof COOLED;

/**
 * Record what a call's exit proved about one route it went through. A
 * failure scoped to the route cools it (a healthy route, or the probe's
 * failure: a call admitted before the route cooled says nothing new); any
 * other end of the probe opens it; a success, or a failure of the request
 * alone, of a call admitted while healthy ends the failure streak.
 */
const settle = (
  route: Route,
  { scope }: RoutePolicy,
  pass: Pass,
  exit: Exit.Exit<unknown, unknown>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)) return;
    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
    if (error instanceof ModelError && error.scope === scope) {
      if (pass === 'healthy' && !route.healthy) return;
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
      route.healthy = false;
      return;
    }
    // A success admitted while healthy proves a clean round trip, so the
    // streak ends here, not on the probe's success: the cohort it releases
    // may fail again at once (a rate window that fits one probe rarely fits
    // the herd), and resetting there would hold the backoff at its base.
    if (pass === 'probe') route.healthy = true;
    else if (route.healthy) route.failures = 0;
  });

/**
 * Run `attempt` through `routes` from `index` on, narrowest first, `passed`
 * the routes it went through healthy so far. A healthy route admits at once.
 * A cooling route's call takes its probe permit: if the route opened while it
 * queued it goes with the cohort, else it waits out the backoff and goes as
 * the probe, holding the permit until its exit is recorded, so no
 * interruption can lose it. Before the attempt, a route passed healthy that
 * cooled meanwhile answers `COOLED`, and the call waits again.
 */
const through = <A, E, R>(
  routes: readonly (readonly [Route, RoutePolicy])[],
  index: number,
  passed: readonly Route[],
  attempt: Effect.Effect<A, E, R>,
): Effect.Effect<Through<A, E>, never, R> =>
  Effect.suspend((): Effect.Effect<Through<A, E>, never, R> => {
    const step = routes[index];
    if (step === undefined)
      return passed.every((route) => route.healthy)
        ? Effect.exit(attempt)
        : Effect.succeed(COOLED);
    const [route, policy] = step;
    const healthy = Effect.flatMap(
      through(routes, index + 1, [...passed, route], attempt),
      (result): Effect.Effect<Through<A, E>> =>
        result === COOLED
          ? Effect.succeed(result)
          : Effect.as(settle(route, policy, 'healthy', result), result),
    );
    if (route.healthy) return healthy;
    return route.probe
      .withPermit(
        Effect.gen(function* (): Generator<
          Effect.Effect<unknown, never, R>,
          Through<A, E> | 'opened'
        > {
          if (route.healthy) return 'opened';
          const delayMs = route.retryAt - (yield* Clock.currentTimeMillis);
          if (delayMs > 0) {
            yield* Effect.logDebug(
              `Waiting ${delayMs}ms for the model recovery probe.`,
            );
            yield* Effect.sleep(delayMs);
          }
          const result = yield* through(routes, index + 1, passed, attempt);
          if (result !== COOLED) yield* settle(route, policy, 'probe', result);
          return result;
        }),
      )
      .pipe(
        Effect.flatMap((result) =>
          result === 'opened' ? healthy : Effect.succeed(result),
        ),
      );
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
      healthy: true,
      probe: Semaphore.makeUnsafe(1),
      failures: 0,
      retryAt: 0,
    };
    routes.set(key, created);
    return created;
  };
  return {
    withRoutes: (policies) => (attempt) => {
      const steps = policies.map(
        (policy) => [routeOf(policy.key), policy] as const,
      );
      const run = <A, E, R>(
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E, R> =>
        Effect.flatMap(through(steps, 0, [], effect), (result) =>
          result === COOLED ? run(effect) : result,
        );
      return run(attempt);
    },
  };
};
