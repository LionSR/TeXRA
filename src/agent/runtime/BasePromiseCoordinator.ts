/**
 * Generic promise-based coordinator for user interaction flows.
 *
 * Provides a reusable pattern for:
 * - Retry requests (after API failures)
 * - Agent proposals (workflow/tool-use delegation)
 * - Future interactive flows
 *
 * Architecture:
 * - Single Map tracks all pending requests by ID
 * - Promise-based: callers await a Promise that resolves on user action
 * - Two states: pending (waiting) or resolved (done)
 *
 * Flow:
 * 1. Caller invokes waitForUserAction() → returns Promise, emits show event
 * 2. User acts → appropriate method resolves Promise with result
 * 3. On resolution → emits resolve event to dismiss UI, defers cleanup
 */

import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';

// ============================================================================
// Types
// ============================================================================

/** Base result type - subclasses extend with specific actions */
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

/** Internal state: pending (waiting for user) or resolved (done) */
type RequestState<TResult> =
  | {
      status: 'pending';
      resolve: (result: TResult) => void;
      runtimeHost: AgentRuntimeHost;
      timeoutId?: NodeJS.Timeout;
    }
  | { status: 'resolved' };

/** Configuration for coordinator behavior */
export interface CoordinatorConfig {
  /** Event name emitted to show UI (e.g., 'showRetryRequest') */
  showEventName: keyof ProgressEventPayloads;
  /** Event name emitted to resolve/hide UI (e.g., 'resolveRetryRequest') */
  resolveEventName: keyof ProgressEventPayloads;
  /** Field name for ID in resolve event payload (e.g., 'streamId', 'proposalId') */
  idFieldName: string;
}

// ============================================================================
// Base Coordinator Implementation
// ============================================================================

/**
 * Generic coordinator for promise-based user interaction flows.
 * Subclasses provide specific result types and event configurations.
 */
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

  /** Single source of truth for all pending requests */
  protected readonly requests = new Map<string, RequestState<TResult>>();

  /** Configuration for this coordinator */
  protected abstract readonly config: CoordinatorConfig;

  /**
   * Get the default result for cancelled/replaced requests.
   * Subclasses override to provide appropriate default (e.g., { action: 'cancel' }).
   */
  protected abstract getDefaultCancelResult(): TResult;

  /**
   * Wait for user action. Emits show event and returns Promise.
   *
   * @param id - Unique identifier for this request
   * @param payload - Data to emit with show event
   * @param options - Optional timeout configuration
   * @returns Promise that resolves with user's action
   */
  waitForUserAction(
    id: string,
    payload: TShowPayload,
    options?: { timeoutMs?: number; onTimeout?: () => TResult },
  ): Promise<TResult> {
    const runtimeHost = this.runtimeHost;

    // Cancel any existing pending request for this ID
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

      // Emit show event (cast needed for generic base class)
      runtimeHost.emit(this.config.showEventName, payload as any);
    });
  }

  /**
   * Get timeout result. Override if different from cancel.
   */
  protected getTimeoutResult(): TResult {
    return { action: 'timeout' } as TResult;
  }

  /**
   * Check if a request is pending.
   */
  hasPendingRequest(id: string): boolean {
    return this.getPendingRequest(id) !== null;
  }

  /**
   * Clear a pending request without user action.
   * Used for cleanup when flow is cancelled externally.
   */
  clearRequest(id: string): void {
    const req = this.getPendingRequest(id);
    if (!req) return;

    clearTimeout(req.timeoutId);
    req.resolve(this.getDefaultCancelResult());
    this.cleanup(id, req.runtimeHost);
  }

  /**
   * Clear every pending request owned by this coordinator.
   */
  clearAll(): void {
    for (const id of this.requests.keys()) {
      this.clearRequest(id);
    }
  }

  // ==========================================================================
  // Protected helpers for subclasses
  // ==========================================================================

  /**
   * Get a pending request if it exists.
   */
  protected getPendingRequest(
    id: string,
  ): (RequestState<TResult> & { status: 'pending' }) | null {
    const req = this.requests.get(id);
    return req?.status === 'pending' ? req : null;
  }

  /**
   * Resolve a pending request with a result.
   */
  resolveRequest(id: string, result: TResult): boolean {
    const req = this.getPendingRequest(id);
    if (!req) return false;

    clearTimeout(req.timeoutId);
    req.resolve(result);
    this.cleanup(id, req.runtimeHost);
    return true;
  }

  /**
   * Clean up state and emit resolution event.
   */
  private cleanup(id: string, runtimeHost: AgentRuntimeHost): void {
    this.requests.set(id, { status: 'resolved' });

    // Emit resolve event (cast needed for generic base class)
    runtimeHost.emit(this.config.resolveEventName, {
      [this.config.idFieldName]: id,
    } as any);

    // Defer Map deletion to avoid blocking current execution
    setImmediate(() => {
      if (this.requests.get(id)?.status === 'resolved') {
        this.requests.delete(id);
      }
    });
  }
}
