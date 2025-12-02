/**
 * RetryRequestCoordinator - Promise-based state machine for manual retry handling.
 *
 * Replaces the callback-based ManualRetryController with a clean Promise-based API.
 * The coordinator manages the entire lifecycle of retry requests using explicit state
 * transitions rather than nested callbacks.
 *
 * Architecture:
 * - Single source of truth: One Map tracks all pending retry requests
 * - Promise-based: Agents await a Promise that resolves when user acts
 * - Explicit state machine: States are {pending, executing, resolved}
 * - Collocated ownership: Promise creation and resolution in same module
 *
 * Flow:
 * 1. Agent calls `waitForUserAction()` - returns Promise, emits 'showRetryRequest'
 * 2. User clicks retry → `triggerRetry()` → executes retry → resolves Promise
 * 3. Or: User cancels → `cancelRetry()` → resolves Promise with 'cancel'
 * 4. Or: Timeout → auto-resolves Promise with 'timeout'
 * 5. On resolution → emits 'resolveRetryRequest' to dismiss UI
 */

// Local imports
import type { AgentLogger } from '@logger/AgentLogger';
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
}

/**
 * Internal state machine states for a retry request.
 */
type RetryRequestState =
  | {
      status: 'pending';
      resolve: (result: RetryResult) => void;
      timeoutId: NodeJS.Timeout;
      logger: AgentLogger;
      operation: string;
    }
  | {
      status: 'executing';
      startGeneration: number;
      resolve: (result: RetryResult) => void;
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
 * Manages pending retry requests with explicit state machine transitions.
 * This is a singleton module-level coordinator (same pattern as the old controller).
 */
class RetryRequestCoordinatorImpl {
  /** Single source of truth for all pending retry requests */
  private readonly requests = new Map<string, RetryRequestState>();

  /**
   * Generation counter to detect stale completions.
   * Incremented when a new request is registered for a stream.
   */
  private readonly generations = new Map<string, number>();

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
    const { logger, operation, errorMessage, model, timeoutMs } = options;

    // Increment generation to invalidate any stale completions
    this.nextGeneration(streamId);

    logger.debug(`Waiting for manual retry: ${errorMessage ?? 'unknown error'}`);

    return new Promise<RetryResult>((resolve) => {
      // Set up timeout
      const timeoutId = setTimeout(() => {
        const req = this.requests.get(streamId);
        if (req?.status === 'pending') {
          logger.warn('Manual retry wait timed out after 5 minutes');
          this.resolveRequest(streamId, { action: 'timeout' });
        }
      }, timeoutMs ?? DEFAULT_TIMEOUT_MS);

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
      });
    });
  }

  /**
   * Trigger a retry for a stream. Called when user clicks the retry button.
   * Resolves the pending Promise with 'retry' action.
   *
   * @param streamId - The stream to retry
   * @returns true if retry was triggered, false if no pending request
   */
  triggerRetry(streamId: string): boolean {
    const req = this.requests.get(streamId);
    if (!req || req.status !== 'pending') {
      return false;
    }

    const { resolve, timeoutId, logger, operation } = req;

    // Clear timeout before transitioning state
    clearTimeout(timeoutId);

    // Capture generation before we might re-register
    const startGeneration = this.getGeneration(streamId);

    // Transition to executing state (in case we need to track execution)
    // For now, we resolve immediately since the actual retry is handled by the flow
    this.requests.set(streamId, {
      status: 'executing',
      startGeneration,
      resolve,
      logger,
      operation,
    });

    logger.debug(`Retry requested for ${operation}`);

    // Resolve the Promise - the flow will handle the actual retry
    resolve({ action: 'retry' });

    // Clean up if no new request was registered during the resolve
    if (this.getGeneration(streamId) === startGeneration) {
      this.cleanup(streamId);
    }

    return true;
  }

  /**
   * Cancel a retry for a stream. Called when user clicks the cancel button.
   * Resolves the pending Promise with 'cancel' action.
   *
   * @param streamId - The stream to cancel
   * @returns true if cancelled, false if no pending request
   */
  cancelRetry(streamId: string): boolean {
    const req = this.requests.get(streamId);
    if (!req || req.status !== 'pending') {
      return false;
    }

    const { logger, operation } = req;
    logger.debug(`Retry cancelled for ${operation}`);

    this.resolveRequest(streamId, { action: 'cancel' });
    return true;
  }

  /**
   * Check if a retry request is pending for a stream.
   */
  hasPendingRequest(streamId: string): boolean {
    const req = this.requests.get(streamId);
    return req?.status === 'pending';
  }

  /**
   * Clear a pending retry request without resolving it.
   * Used for cleanup when the flow is cancelled externally.
   *
   * @param streamId - The stream to clear
   */
  clearRequest(streamId: string): void {
    const req = this.requests.get(streamId);
    if (!req || req.status === 'resolved') {
      return;
    }

    if (req.status === 'pending') {
      clearTimeout(req.timeoutId);
    }

    // Don't resolve the Promise - let it hang (the flow is being cancelled anyway)
    this.cleanup(streamId);
  }

  // ==========================================================================
  // Private helpers
  // ==========================================================================

  /**
   * Resolve a pending request and clean up.
   */
  private resolveRequest(streamId: string, result: RetryResult): void {
    const req = this.requests.get(streamId);
    if (!req || req.status === 'resolved') {
      return;
    }

    if (req.status === 'pending') {
      clearTimeout(req.timeoutId);
      req.resolve(result);
    } else if (req.status === 'executing') {
      req.resolve(result);
    }

    this.cleanup(streamId);
  }

  /**
   * Clean up state and emit UI resolution event.
   */
  private cleanup(streamId: string): void {
    this.requests.set(streamId, { status: 'resolved' });
    this.generations.delete(streamId);

    // Use setImmediate to avoid blocking the current execution
    // and ensure the UI event is processed after the Promise resolves
    setImmediate(() => {
      this.requests.delete(streamId);
      bus.emit('resolveRetryRequest', { streamId });
    });
  }

  /**
   * Get the current generation for a stream.
   */
  private getGeneration(streamId: string): number {
    return this.generations.get(streamId) ?? 0;
  }

  /**
   * Increment and return the new generation for a stream.
   */
  private nextGeneration(streamId: string): number {
    const next = this.getGeneration(streamId) + 1;
    this.generations.set(streamId, next);
    return next;
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
