/**
 * Generic promise-based coordinator for user-interaction flows
 * (retry requests, agent proposals, plan approvals, ...).
 *
 * Each request is keyed by a string id. waitForUserAction() returns a Promise
 * that resolves when a corresponding resolveRequest()/clearRequest() runs.
 * Replacing a still-pending id auto-rejects the previous waiter with
 * getDefaultCancelResult().
 */

import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';

/** Base result type — subclasses extend with specific actions. */
interface BaseResult {
  action: string;
  feedback?: string;
}

type RuntimeHostProvider = () => AgentRuntimeHost;

export type CoordinatorRuntimeHost = AgentRuntimeHost | RuntimeHostProvider;

function toRuntimeHostProvider(
  runtimeHost: CoordinatorRuntimeHost,
): RuntimeHostProvider {
  return typeof runtimeHost === 'function' ? runtimeHost : () => runtimeHost;
}

type RequestState<TResult> =
  | {
      status: 'pending';
      resolve: (result: TResult) => void;
      runtimeHost: AgentRuntimeHost;
      timeoutId?: NodeJS.Timeout;
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
    this.getRuntimeHost = toRuntimeHostProvider(runtimeHost);
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
      clearTimeout(existing.timeoutId);
      existing.resolve(this.getDefaultCancelResult());
      this.cleanup(id, existing.runtimeHost);
    }

    return new Promise<TResult>((resolve) => {
      let timeoutId: NodeJS.Timeout | undefined;
      if (options?.timeoutMs && options.timeoutMs > 0) {
        timeoutId = setTimeout(() => {
          const req = this.requests.get(id);
          if (req?.status === 'pending' && req.resolve === resolve) {
            const result = options.onTimeout?.() ?? this.getTimeoutResult();
            this.resolveRequest(id, result);
          }
        }, options.timeoutMs);
      }

      this.requests.set(id, {
        status: 'pending',
        resolve,
        runtimeHost,
        timeoutId,
      });

      runtimeHost.emit(this.config.showEventName, payload as any);
    });
  }

  hasPendingRequest(id: string): boolean {
    return this.getPendingRequest(id) !== null;
  }

  /** Clear a pending request without user action (external cancellation). */
  clearRequest(id: string): void {
    const req = this.getPendingRequest(id);
    if (!req) return;

    clearTimeout(req.timeoutId);
    req.resolve(this.getDefaultCancelResult());
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

    clearTimeout(req.timeoutId);
    req.resolve(result);
    this.cleanup(id, req.runtimeHost);
    return true;
  }

  private cleanup(id: string, runtimeHost: AgentRuntimeHost): void {
    this.requests.set(id, { status: 'resolved' });

    runtimeHost.emit(this.config.resolveEventName, {
      [this.config.idFieldName]: id,
    } as any);

    // Defer Map deletion so callers re-entering this method (e.g. resolving
    // and then immediately re-checking pending state) see the resolved entry.
    setImmediate(() => {
      if (this.requests.get(id)?.status === 'resolved') {
        this.requests.delete(id);
      }
    });
  }
}
