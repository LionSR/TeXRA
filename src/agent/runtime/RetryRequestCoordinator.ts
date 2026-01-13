/**
 * RetryRequestCoordinator - Promise-based coordinator for manual retry handling.
 *
 * Replaces the callback-based ManualRetryController with a clean Promise-based API.
 * The coordinator manages the lifecycle of retry requests.
 *
 * Architecture:
 * - Single source of truth: One Map tracks all pending retry requests
 * - Promise-based: Agents await a Promise that resolves when user acts
 * - Two states: pending (waiting for user) and resolved (done)
 *
 * Flow:
 * 1. Agent calls `waitForUserAction()` - returns Promise, emits 'showRetryRequest'
 * 2. User clicks retry → `triggerRetry()` → resolves Promise with 'retry'
 * 3. Or: User cancels → `cancelRetry()` → resolves Promise with 'cancel'
 * 4. Or: Timeout → auto-resolves Promise with 'timeout'
 * 5. On resolution → emits 'resolveRetryRequest' to dismiss UI
 */

// Local imports
import type { AgentLogger } from '@logger/AgentLogger';
import type { RetryErrorDetails } from '@eventBus/types';
import { bus } from '@eventBus/ProgressEventBus';

// ============================================================================
// Types
// ============================================================================

/**
 * Result of a retry request. Discriminated union for type-safe handling.
 */
export type RetryResult =
  | { action: 'retry' }
  | { action: 'cancel' }
  | { action: 'timeout' };

/**
 * Options for initiating a retry request.
 */
export interface RetryRequestOptions {
  /** Name of the operation that failed (e.g., "Model invocation") */
  operation: string;
  /** Error message to display to user */
  errorMessage?: string;
  /** Model name for context */
  model?: string;
  /** Logger for debug messages */
  logger: AgentLogger;
  /** Timeout in milliseconds (defaults to 5 minutes) */
  timeoutMs?: number;
  /** Structured error details for expandable display */
  errorDetails?: RetryErrorDetails;
}

/**
 * Internal state for a retry request.
 * Only two states: pending (waiting for user action) or resolved (done).
 */
type RetryRequestState =
  | {
      status: 'pending';
      resolve: (result: RetryResult) => void;
      timeoutId: NodeJS.Timeout;
      logger: AgentLogger;
      operation: string;
    }
  | { status: 'resolved' };

// ============================================================================
// Constants
// ============================================================================

/** Default timeout for manual retry wait (5 minutes) */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

// ============================================================================
// Coordinator Implementation
// ============================================================================

/**
 * Manages pending retry requests.
 * This is a singleton module-level coordinator.
 */
class RetryRequestCoordinatorImpl {
  /** Single source of truth for all pending retry requests */
  private readonly requests = new Map<string, RetryRequestState>();

  /**
   * Wait for user action on a retry request.
   * The Promise resolves when the user clicks retry, cancel, or timeout occurs.
   *
   * @param streamId - Unique identifier for the stream
   * @param options - Request options including operation name and error message
   * @returns Promise that resolves with the user's action
   */
  waitForUserAction(
    streamId: string,
    options: RetryRequestOptions,
  ): Promise<RetryResult> {
    const { logger, operation, errorMessage, model, timeoutMs, errorDetails } =
      options;

    // If there's an existing pending request for this stream, cancel it first.
    // This prevents stale timeouts from resolving the wrong request.
    const existingReq = this.requests.get(streamId);
    if (existingReq?.status === 'pending') {
      clearTimeout(existingReq.timeoutId);
      existingReq.resolve({ action: 'cancel' });
      // Don't call cleanup() here - we're about to overwrite the entry anyway
    }

    logger.debug(
      `Waiting for manual retry: ${errorMessage ?? 'unknown error'}`,
    );

    return new Promise<RetryResult>((resolve) => {
      const actualTimeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const timeoutId = setTimeout(() => {
        // Check if this request is still pending (wasn't resolved by user action)
        const req = this.requests.get(streamId);
        if (req?.status === 'pending' && req.resolve === resolve) {
          const timeoutMinutes = Math.round(actualTimeoutMs / 60000);
          logger.warn(
            `Manual retry wait timed out after ${timeoutMinutes} minutes`,
          );
          this.resolveRequest(streamId, { action: 'timeout' });
        }
      }, actualTimeoutMs);

      // Store pending state
      this.requests.set(streamId, {
        status: 'pending',
        resolve,
        timeoutId,
        logger,
        operation,
      });

      // Emit event to show retry request in UI
      bus.emit('showRetryRequest', {
        streamId,
        operation,
        model,
        errorMessage,
        errorDetails,
      });
    });
  }

  /**
   * Handle a user action (retry or cancel) for a pending request.
   * @returns true if the action was handled, false if no pending request
   */
  private handleUserAction(
    streamId: string,
    action: 'retry' | 'cancel',
  ): boolean {
    const req = this.getPendingRequest(streamId);
    if (!req) return false;

    const actionLabel = action === 'retry' ? 'requested' : 'cancelled';
    req.logger.debug(`Retry ${actionLabel} for ${req.operation}`);
    this.resolveRequest(streamId, { action });
    return true;
  }

  /**
   * Trigger a retry for a stream. Called when user clicks the retry button.
   * Resolves the pending Promise with 'retry' action.
   *
   * @param streamId - The stream to retry
   * @returns true if retry was triggered, false if no pending request
   */
  triggerRetry(streamId: string): boolean {
    return this.handleUserAction(streamId, 'retry');
  }

  /**
   * Cancel a retry for a stream. Called when user clicks the cancel button.
   * Resolves the pending Promise with 'cancel' action.
   *
   * @param streamId - The stream to cancel
   * @returns true if cancelled, false if no pending request
   */
  cancelRetry(streamId: string): boolean {
    return this.handleUserAction(streamId, 'cancel');
  }

  /**
   * Check if a retry request is pending for a stream.
   */
  hasPendingRequest(streamId: string): boolean {
    return this.getPendingRequest(streamId) !== null;
  }

  /**
   * Clear a pending retry request without resolving it.
   * Used for cleanup when the flow is cancelled externally.
   *
   * @param streamId - The stream to clear
   */
  clearRequest(streamId: string): void {
    const req = this.getPendingRequest(streamId);
    if (!req) return;

    clearTimeout(req.timeoutId);
    // Resolve with cancel to avoid hanging Promise and potential memory leak
    req.resolve({ action: 'cancel' });
    this.cleanup(streamId);
  }

  // ==========================================================================
  // Private helpers
  // ==========================================================================

  /**
   * Get a pending request if it exists, or null otherwise.
   * Type-safe accessor that narrows the discriminated union.
   */
  private getPendingRequest(
    streamId: string,
  ): (RetryRequestState & { status: 'pending' }) | null {
    const req = this.requests.get(streamId);
    return req?.status === 'pending' ? req : null;
  }

  /**
   * Resolve a pending request and clean up.
   */
  private resolveRequest(streamId: string, result: RetryResult): void {
    const req = this.getPendingRequest(streamId);
    if (!req) return;

    clearTimeout(req.timeoutId);
    req.resolve(result);
    this.cleanup(streamId);
  }

  /**
   * Clean up state and emit UI resolution event.
   */
  private cleanup(streamId: string): void {
    this.requests.set(streamId, { status: 'resolved' });

    // Emit UI event synchronously so UI updates immediately
    bus.emit('resolveRetryRequest', { streamId });

    // Defer Map deletion to avoid blocking current execution
    setImmediate(() => {
      // Only delete if still resolved (not replaced by a new request)
      const req = this.requests.get(streamId);
      if (req?.status === 'resolved') {
        this.requests.delete(streamId);
      }
    });
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

/**
 * Singleton coordinator instance.
 * This is a module-level singleton, matching the pattern of the old controller.
 */
export const retryCoordinator = new RetryRequestCoordinatorImpl();
