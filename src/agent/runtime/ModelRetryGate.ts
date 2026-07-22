const MAX_BACKOFF_MS = 5 * 60 * 1000;
const JITTER_FRACTION = 0.2;

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
  retryAt: number;
  refreshOnAdmission: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  readonly waiters: WaitingAttempt[];
}

interface RetryPermit {
  readonly version: number;
  readonly probe: boolean;
  readonly sharedRecoveryCompleted: boolean;
}

interface RouteFailure {
  readonly retryAfterMs?: number;
}

interface RunOptions<T> {
  readonly signal: AbortSignal;
  readonly baseBackoffMs: number;
  readonly classifyFailure: (error: Error) => RouteFailure | undefined;
  /**
   * Return a deferred recovery for failures the current call can repair. The
   * gate claims the recovery probe before invoking it, so peer calls remain
   * queued while the repair and immediate retry run.
   */
  readonly recoverFailure?: (
    error: Error,
    retry: () => Promise<T>,
  ) => (() => Promise<T>) | undefined;
  readonly onWait?: (delayMs: number) => void;
  readonly onAdmitted?: () => void | Promise<void>;
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
 */
export class ModelRetryGate {
  private readonly routes = new Map<string, RouteState>();
  private disposed = false;

  async run<T>(
    route: string,
    options: RunOptions<T>,
    operation: () => Promise<T>,
  ): Promise<T> {
    const permit = await this.acquire(route, options);
    try {
      if (permit.sharedRecoveryCompleted) await options.onAdmitted?.();
      const result = await operation();
      this.markReachable(route, permit);
      return result;
    } catch (error) {
      if (options.signal.aborted) {
        this.abandon(route, permit);
      } else {
        const failure = options.classifyFailure(error as Error);
        if (failure) {
          const recovery = options.recoverFailure?.(error as Error, operation);
          if (recovery) {
            const recoveryPermit = this.claimRecovery(route, permit);
            if (!recoveryPermit) {
              // Another in-flight call already owns recovery. Re-enter the
              // gate so this stale call waits for that probe, then retries
              // with the repaired shared credential or route.
              return this.run(route, options, operation);
            }

            try {
              const result = await recovery();
              this.markReachable(route, recoveryPermit, true);
              return result;
            } catch (recoveryError) {
              if (options.signal.aborted) {
                this.abandon(route, recoveryPermit);
              } else {
                const recoveryFailure = options.classifyFailure(
                  recoveryError as Error,
                );
                if (recoveryFailure) {
                  this.markRouteFailure(
                    route,
                    recoveryPermit,
                    options.baseBackoffMs,
                    recoveryFailure.retryAfterMs,
                  );
                } else {
                  this.markReachable(route, recoveryPermit);
                }
              }
              throw recoveryError;
            }
          }
          this.markRouteFailure(
            route,
            permit,
            options.baseBackoffMs,
            failure.retryAfterMs,
          );
        } else {
          this.markReachable(route, permit);
        }
      }
      throw error;
    }
  }

  private claimRecovery(
    route: string,
    permit: RetryPermit,
  ): RetryPermit | undefined {
    const state = this.routes.get(route);
    if (!state || permit.version !== state.version) return undefined;
    if (state.phase === 'probing' && permit.probe) {
      state.refreshOnAdmission = true;
      return permit;
    }
    if (state.phase !== 'healthy') return undefined;

    state.version += 1;
    state.phase = 'probing';
    state.retryAt = Date.now();
    state.refreshOnAdmission = true;
    return {
      version: state.version,
      probe: true,
      sharedRecoveryCompleted: permit.sharedRecoveryCompleted,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const error = new DOMException('Model retry gate disposed', 'AbortError');
    for (const state of this.routes.values()) {
      if (state.timer) clearTimeout(state.timer);
      const waiters = state.waiters.splice(0);
      for (const waiter of waiters) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
        waiter.reject(error);
      }
    }
    this.routes.clear();
  }

  private acquire(
    route: string,
    options: Pick<RunOptions<never>, 'signal' | 'onWait'>,
  ): Promise<RetryPermit> {
    if (this.disposed) {
      return Promise.reject(
        new DOMException('Model retry gate disposed', 'AbortError'),
      );
    }

    const state = this.routes.get(route);
    if (!state || state.phase === 'healthy') {
      const healthyState = state ?? {
        version: 0,
        phase: 'healthy' as const,
        failures: 0,
        retryAt: 0,
        refreshOnAdmission: false,
        timer: undefined,
        waiters: [],
      };
      this.routes.set(route, healthyState);
      return Promise.resolve({
        version: healthyState.version,
        probe: false,
        sharedRecoveryCompleted: false,
      });
    }

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
          reject(abortReason(options.signal));
        },
      };
      options.signal.addEventListener('abort', waiter.onAbort, { once: true });
      state.waiters.push(waiter);
      this.scheduleProbe(state);
    });
  }

  private markRouteFailure(
    route: string,
    permit: RetryPermit,
    baseBackoffMs: number,
    retryAfterMs?: number,
  ): void {
    const state = this.routes.get(route);
    if (!state || permit.version !== state.version) return;
    if (state.phase !== 'healthy' && !permit.probe) return;

    state.version += 1;
    state.phase = 'cooling';
    state.failures += 1;
    state.retryAt =
      Date.now() +
      Math.max(
        this.backoffMs(baseBackoffMs, state.failures),
        retryAfterMs ?? 0,
      );
    this.scheduleProbe(state);
  }

  private markReachable(
    route: string,
    permit: RetryPermit,
    sharedRecoveryCompleted = false,
  ): void {
    const state = this.routes.get(route);
    if (!state || state.phase === 'healthy') return;
    if (permit.version !== state.version) return;
    if (state.phase === 'probing' && !permit.probe) return;

    const refreshOnAdmission =
      sharedRecoveryCompleted ||
      permit.sharedRecoveryCompleted ||
      state.refreshOnAdmission;
    state.version += 1;
    state.phase = 'healthy';
    state.failures = 0;
    state.retryAt = 0;
    state.refreshOnAdmission = false;
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
    const waiters = state.waiters.splice(0);
    for (const waiter of waiters) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      waiter.resolve({
        version: state.version,
        probe: false,
        sharedRecoveryCompleted: refreshOnAdmission,
      });
    }
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
          sharedRecoveryCompleted: state.refreshOnAdmission,
        });
      },
      Math.max(0, state.retryAt - Date.now()),
    );
  }

  private backoffMs(baseBackoffMs: number, failures: number): number {
    const exponential = Math.min(
      MAX_BACKOFF_MS,
      Math.max(0, baseBackoffMs) * 2 ** Math.max(0, failures - 1),
    );
    const jitter = 1 - JITTER_FRACTION + Math.random() * 2 * JITTER_FRACTION;
    return Math.min(MAX_BACKOFF_MS, Math.round(exponential * jitter));
  }
}
