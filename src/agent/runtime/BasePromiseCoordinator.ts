/**
 * Generic promise-based coordinator for user-interaction flows
 * (retry requests, agent proposals, plan approvals, ...).
 *
 * Each request is keyed by a string id. waitForUserAction() returns a Promise
 * that resolves when a corresponding resolveRequest()/clearRequest() runs.
 * Replacing a still-pending id auto-rejects the previous waiter with
 * getDefaultCancelResult().
 */

import pDefer, { type DeferredPromise } from 'p-defer';
import pTimeout from 'p-timeout';

import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';
import type { AgentRuntimeHost } from '@hosts/AgentRuntimeHost';

/** Base result type — subclasses extend with specific actions. */
interface BaseResult {
  action: string;
  feedback?: string;
}

type RuntimeHostProvider = () => AgentRuntimeHost;

export type CoordinatorRuntimeHost = AgentRuntimeHost | RuntimeHostProvider;

type RequestState<TResult> =
  | {
      status: 'pending';
      deferred: DeferredPromise<TResult>;
      runtimeHost: AgentRuntimeHost;
      /** Cancels the pTimeout timer; no-op when no timeout was set. */
      cancelTimeout: () => void;
    }
  | { status: 'resolved' };

export interface CoordinatorConfig {
  /** Event name emitted to show UI (e.g. 'showRetryRequest'). */
  showEventName: keyof ProgressEventPayloads;
  /** Event name emitted to resolve/hide UI (e.g. 'resolveRetryRequest'). */
  resolveEventName: keyof ProgressEventPayloads;
  /** Field name for the id in the resolve event payload (e.g. 'streamId', 'proposalId'). */
  idFieldName: string;
}

export abstract class BasePromiseCoordinator<
  TResult extends BaseResult,
  TShowPayload extends Record<string, unknown>,
> {
  private readonly getRuntimeHost: RuntimeHostProvider;

  constructor(runtimeHost: CoordinatorRuntimeHost) {
    this.getRuntimeHost =
      typeof runtimeHost === 'function' ? runtimeHost : () => runtimeHost;
  }

  protected get runtimeHost(): AgentRuntimeHost {
    return this.getRuntimeHost();
  }

  protected readonly requests = new Map<string, RequestState<TResult>>();

  protected abstract readonly config: CoordinatorConfig;

  /** Result used when a pending request is cancelled or replaced. */
  protected abstract getDefaultCancelResult(): TResult;

  /** Result used on timeout (defaults to `{ action: 'timeout' }`). */
  protected getTimeoutResult(): TResult {
    return { action: 'timeout' } as TResult;
  }

  /**
   * Wait for user action. Emits the show event and returns a Promise that
   * resolves once the user (or timeout) decides.
   */
  waitForUserAction(
    id: string,
    payload: TShowPayload,
    options?: { timeoutMs?: number; onTimeout?: () => TResult },
  ): Promise<TResult> {
    const runtimeHost = this.runtimeHost;

    const existing = this.requests.get(id);
    if (existing?.status === 'pending') {
      existing.cancelTimeout();
      existing.deferred.resolve(this.getDefaultCancelResult());
      this.cleanup(id, existing.runtimeHost);
    }

    const deferred = pDefer<TResult>();
    const pending: RequestState<TResult> & { status: 'pending' } = {
      status: 'pending',
      deferred,
      runtimeHost,
      cancelTimeout: () => {},
    };
    this.requests.set(id, pending);

    // Start the timeout timer before emitting the show event, matching the
    // original setTimeout-before-emit ordering so that synchronous work in
    // show handlers is counted against the caller's timeoutMs budget.
    let returnPromise: Promise<TResult> = deferred.promise;
    if (options?.timeoutMs && options.timeoutMs > 0) {
      const timedPromise = pTimeout(deferred.promise, {
        milliseconds: options.timeoutMs,
        fallback: () => {
          const result = options.onTimeout?.() ?? this.getTimeoutResult();
          this.resolveRequest(id, result);
          return result;
        },
      });
      // Store the clear fn so resolveRequest/clearRequest can cancel the timer.
      pending.cancelTimeout = timedPromise.clear.bind(timedPromise);
      returnPromise = timedPromise;
    }

    // `showEventName` is a runtime-variable key into ProgressEventPayloads,
    // so TS can't correlate it with `payload`'s type. Cast to the payload
    // the emitter expects for that key set rather than discarding all
    // checking with `any`.
    runtimeHost.emit(
      this.config.showEventName,
      payload as ProgressEventPayloads[keyof ProgressEventPayloads],
    );

    return returnPromise;
  }

  hasPendingRequest(id: string): boolean {
    return this.getPendingRequest(id) !== null;
  }

  /** Clear a pending request without user action (external cancellation). */
  clearRequest(id: string): void {
    const req = this.getPendingRequest(id);
    if (!req) return;

    req.cancelTimeout();
    req.deferred.resolve(this.getDefaultCancelResult());
    this.cleanup(id, req.runtimeHost);
  }

  clearAll(): void {
    for (const id of this.requests.keys()) {
      this.clearRequest(id);
    }
  }

  protected getPendingRequest(
    id: string,
  ): (RequestState<TResult> & { status: 'pending' }) | null {
    const req = this.requests.get(id);
    return req?.status === 'pending' ? req : null;
  }

  resolveRequest(id: string, result: TResult): boolean {
    const req = this.getPendingRequest(id);
    if (!req) return false;

    req.cancelTimeout();
    req.deferred.resolve(result);
    this.cleanup(id, req.runtimeHost);
    return true;
  }

  private cleanup(id: string, runtimeHost: AgentRuntimeHost): void {
    this.requests.set(id, { status: 'resolved' });

    // Computed-key payload for a runtime-variable resolve event — same
    // dynamic-key limitation as the show event in waitForUserAction.
    runtimeHost.emit(this.config.resolveEventName, {
      [this.config.idFieldName]: id,
    } as ProgressEventPayloads[keyof ProgressEventPayloads]);

    // Defer Map deletion so callers re-entering this method (e.g. resolving
    // and then immediately re-checking pending state) see the resolved entry.
    setImmediate(() => {
      if (this.requests.get(id)?.status === 'resolved') {
        this.requests.delete(id);
      }
    });
  }
}
