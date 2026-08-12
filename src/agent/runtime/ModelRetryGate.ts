import { jitteredExponentialBackoffMs } from '@utils/core';

const MAX_BACKOFF_MS = 5 * 60 * 1000;

type RoutePhase = 'healthy' | 'cooling' | 'probing';

interface WaitingAttempt {
  readonly resolve: (permit: RetryPermit) => void;
  readonly reject: (error: unknown) => void;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
}

interface RouteState {
  version: number;
  phase: RoutePhase;
  failures: number;
  releaseProbeBeforeOperation: boolean;
  retryAt: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  readonly waiters: WaitingAttempt[];
}

interface RetryPermit {
  readonly version: number;
  readonly probe: boolean;
}

interface RouteFailure {
  readonly retryAfterMs?: number;
  readonly releaseProbeBeforeOperation?: boolean;
}

interface RoutePolicy {
  readonly key: string;
  readonly classifyFailure: (error: Error) => RouteFailure | undefined;
  readonly isReachableFailure?: (error: Error) => boolean;
  readonly isUnobservedFailure?: (error: Error) => boolean;
  readonly releaseEarlierProbesBeforeWait?: boolean;
}

interface RunOptions {
  readonly signal: AbortSignal;
  readonly baseBackoffMs: number;
  readonly classifyFailure: (error: Error) => RouteFailure | undefined;
  readonly isReachableFailure?: (error: Error) => boolean;
  readonly isUnobservedFailure?: (error: Error) => boolean;
  readonly additionalRoutes?: readonly RoutePolicy[];
  readonly trailingRoutes?: readonly RoutePolicy[];
  readonly onWait?: (delayMs: number) => void;
}

interface AcquiredRoute extends RoutePolicy {
  permit: RetryPermit;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Operation cancelled', 'AbortError');
}

/**
 * Coordinates retries for model calls sharing one provider route.
 *
 * Healthy routes remain fully concurrent. After a shared-route failure, calls
 * on the affected route wait through one shared backoff and exactly one
 * becomes the recovery probe. A successful probe releases the other calls;
 * another route failure increases the shared backoff. The gate does not decide
 * how many times a node retries—that remains the node retry loop's concern.
 * Relay-authentication recovery is likewise not the gate's concern: the token
 * refresh is single-flighted at the auth boundary, and each call's own
 * reactive 401 recovery repairs its client within the same node attempt.
 */
export class ModelRetryGate {
  private readonly routes = new Map<string, RouteState>();
  private disposed = false;

  async run<T>(
    route: string,
    options: RunOptions,
    operation: () => Promise<T>,
  ): Promise<T> {
    const policies: RoutePolicy[] = [
      ...(options.additionalRoutes ?? []),
      {
        key: route,
        classifyFailure: options.classifyFailure,
        isReachableFailure: options.isReachableFailure,
        isUnobservedFailure: options.isUnobservedFailure,
      },
      ...(options.trailingRoutes ?? []),
    ];
    const acquired = await this.acquireAll(policies, options);
    try {
      const result = await operation();
      for (const entry of acquired) {
        this.markReachable(entry.key, entry.permit);
      }
      return result;
    } catch (error) {
      if (options.signal.aborted) {
        for (const entry of acquired) {
          this.abandon(entry.key, entry.permit);
        }
      } else {
        for (const entry of acquired) {
          const failure = entry.classifyFailure(error as Error);
          if (failure) {
            this.markRouteFailure(
              entry.key,
              entry.permit,
              options.baseBackoffMs,
              failure,
            );
          } else if (entry.isReachableFailure?.(error as Error)) {
            this.markReachable(entry.key, entry.permit);
          } else if (entry.isUnobservedFailure?.(error as Error)) {
            // An earlier admission boundary rejected the request, so this
            // route was never observed. Preserve its recovery state.
            this.abandon(entry.key, entry.permit);
          } else if (entry.permit.probe) {
            // An unclassified failure does not prove that a recovering route
            // is reachable. Keep the cohort closed and hand probe ownership
            // to one waiter; shared credential failures can otherwise release
            // every peer before their out-of-gate recovery finishes.
            this.abandon(entry.key, entry.permit);
          } else {
            // A current healthy permit reached the operation boundary. Even
            // when its error is local to that request, it proves that an older
            // shared-route failure streak no longer describes this route.
            this.markReachable(entry.key, entry.permit);
          }
        }
      }
      throw error;
    }
  }

  /**
   * Acquires narrower additional scopes before the primary route and broader
   * trailing scopes after it. A model-specific probe may wait for its shared
   * wire route without blocking healthy sibling models, while a provider wire
   * probe may wait for the shared relay-user gate without reserving that
   * broader probe. A later wait can also make an earlier permit stale, so
   * validate the complete set before sending.
   */
  private async acquireAll(
    routes: readonly RoutePolicy[],
    options: Pick<RunOptions, 'signal' | 'onWait'>,
  ): Promise<AcquiredRoute[]> {
    acquireRoutes: while (true) {
      const acquired: AcquiredRoute[] = [];
      try {
        for (const [routeIndex, route] of routes.entries()) {
          const state = this.routes.get(route.key);
          if (
            route.releaseEarlierProbesBeforeWait &&
            state &&
            state.phase !== 'healthy'
          ) {
            // Wait for an admission route without retaining narrower recovery
            // probes. Hand those probes to their own queued cohorts, then
            // restart from one current set of route states.
            for (const entry of acquired) {
              this.abandon(entry.key, entry.permit);
            }
            acquired.length = 0;
            const permit = await this.acquire(route.key, options);
            const currentState = this.routes.get(route.key);
            if (permit.probe && currentState?.releaseProbeBeforeOperation) {
              this.releaseProbe(route.key, permit);
              continue acquireRoutes;
            }

            // A concurrency probe stays closed until its operation observes a
            // free slot. Reacquire narrower scopes only when all are healthy;
            // otherwise hand off this probe and recover those scopes first.
            const narrower: AcquiredRoute[] = [];
            for (const earlier of routes.slice(0, routeIndex)) {
              const earlierPermit = this.acquireHealthy(earlier.key);
              if (!earlierPermit) {
                for (const entry of narrower) {
                  this.abandon(entry.key, entry.permit);
                }
                this.abandon(route.key, permit);
                continue acquireRoutes;
              }
              narrower.push({ ...earlier, permit: earlierPermit });
            }
            acquired.push(...narrower, { ...route, permit });
            if (
              acquired.every((entry) =>
                this.isCurrentPermit(entry.key, entry.permit),
              )
            ) {
              return acquired;
            }
            for (const entry of acquired) {
              this.abandon(entry.key, entry.permit);
            }
            continue acquireRoutes;
          }
          acquired.push({
            ...route,
            permit: await this.acquire(route.key, options),
          });
        }
      } catch (error) {
        for (const entry of acquired) {
          this.abandon(entry.key, entry.permit);
        }
        throw error;
      }

      if (
        acquired.every((entry) => this.isCurrentPermit(entry.key, entry.permit))
      ) {
        return acquired;
      }
      for (const entry of acquired) {
        this.abandon(entry.key, entry.permit);
      }
    }
  }

  private isCurrentPermit(route: string, permit: RetryPermit): boolean {
    const state = this.routes.get(route);
    if (!state || permit.version !== state.version) return false;
    return permit.probe ? state.phase === 'probing' : state.phase === 'healthy';
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const error = new DOMException('Model retry gate disposed', 'AbortError');
    for (const state of this.routes.values()) {
      if (state.timer) clearTimeout(state.timer);
      for (const waiter of state.waiters.splice(0)) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
        waiter.reject(error);
      }
    }
    this.routes.clear();
  }

  private acquire(
    route: string,
    options: Pick<RunOptions, 'signal' | 'onWait'>,
  ): Promise<RetryPermit> {
    if (this.disposed) {
      return Promise.reject(
        new DOMException('Model retry gate disposed', 'AbortError'),
      );
    }

    const healthyPermit = this.acquireHealthy(route);
    if (healthyPermit) return Promise.resolve(healthyPermit);
    // Safe: acquireHealthy only returns undefined when it found an existing,
    // non-healthy state for `route` (the create-on-miss branch always returns
    // a permit), so the state it read is still in the map here.
    const state = this.routes.get(route)!;

    if (options.signal.aborted) {
      return Promise.reject(abortReason(options.signal));
    }

    const delayMs = Math.max(0, state.retryAt - Date.now());
    options.onWait?.(delayMs);
    return new Promise<RetryPermit>((resolve, reject) => {
      const waiter: WaitingAttempt = {
        resolve,
        reject,
        signal: options.signal,
        onAbort: () => {
          const index = state.waiters.indexOf(waiter);
          if (index >= 0) state.waiters.splice(index, 1);
          if (state.waiters.length === 0 && state.timer) {
            clearTimeout(state.timer);
            state.timer = undefined;
          }
          reject(abortReason(options.signal));
        },
      };
      options.signal.addEventListener('abort', waiter.onAbort, { once: true });
      state.waiters.push(waiter);
      this.scheduleProbe(state);
    });
  }

  private acquireHealthy(route: string): RetryPermit | undefined {
    const state = this.routes.get(route);
    if (state && state.phase !== 'healthy') return undefined;
    const healthyState = state ?? {
      version: 0,
      phase: 'healthy' as const,
      failures: 0,
      releaseProbeBeforeOperation: false,
      retryAt: 0,
      timer: undefined,
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
  ): void {
    const state = this.routes.get(route);
    if (!state || permit.version !== state.version) return;
    if (state.phase !== 'healthy' && !permit.probe) return;

    state.version += 1;
    state.phase = 'cooling';
    state.failures += 1;
    state.releaseProbeBeforeOperation =
      failure.releaseProbeBeforeOperation ?? false;
    state.retryAt =
      Date.now() +
      Math.max(
        jitteredExponentialBackoffMs(
          baseBackoffMs,
          state.failures,
          MAX_BACKOFF_MS,
        ),
        failure.retryAfterMs ?? 0,
      );
    this.scheduleProbe(state);
  }

  private markReachable(route: string, permit: RetryPermit): void {
    const state = this.routes.get(route);
    if (!state) return;
    if (state.phase === 'healthy') {
      // A success admitted while the route was already healthy proves a clean
      // round-trip, so the failure streak ends here — not on probe success,
      // whose released cohort may immediately re-fail (a rate window that fits
      // one probe rarely fits the herd). Resetting on probe success would cap
      // the shared backoff at its base forever in exactly that cycle.
      if (permit.version === state.version) {
        state.failures = 0;
        state.releaseProbeBeforeOperation = false;
      }
      return;
    }
    if (permit.version !== state.version) return;
    if (state.phase === 'probing' && !permit.probe) return;

    state.version += 1;
    state.phase = 'healthy';
    state.releaseProbeBeforeOperation = false;
    state.retryAt = 0;
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
    for (const waiter of state.waiters.splice(0)) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      waiter.resolve({
        version: state.version,
        probe: false,
      });
    }
  }

  /**
   * Opens a request-admission route as soon as its server-provided cooldown
   * admits the recovery attempt. Unlike a transport route, it must not hold
   * the queued cohort until a potentially long-lived model response finishes.
   */
  private releaseProbe(route: string, permit: RetryPermit): void {
    this.markReachable(route, permit);
  }

  private abandon(route: string, permit: RetryPermit): void {
    const state = this.routes.get(route);
    if (
      !state ||
      !permit.probe ||
      permit.version !== state.version ||
      state.phase !== 'probing'
    ) {
      return;
    }

    state.phase = 'cooling';
    state.retryAt = Date.now();
    this.scheduleProbe(state);
  }

  private scheduleProbe(state: RouteState): void {
    if (
      this.disposed ||
      state.phase !== 'cooling' ||
      state.timer ||
      state.waiters.length === 0
    ) {
      return;
    }

    state.timer = setTimeout(
      () => {
        state.timer = undefined;
        if (this.disposed || state.phase !== 'cooling') return;
        const waiter = state.waiters.shift();
        if (!waiter) return;
        waiter.signal.removeEventListener('abort', waiter.onAbort);
        state.phase = 'probing';
        waiter.resolve({
          version: state.version,
          probe: true,
        });
      },
      Math.max(0, state.retryAt - Date.now()),
    );
  }
}
