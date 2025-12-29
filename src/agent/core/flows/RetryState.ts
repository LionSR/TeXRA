/**
 * Retry state management for manual retry handling.
 *
 * Auto-retry AND manual retry are now handled by PocketFlow's Node class:
 * - maxRetries/wait for auto-retry
 * - retryPrompt hook for manual retry UI
 * - execFallback() called only when all retries exhausted
 *
 * This module provides:
 * - Configuration for Node retry parameters
 * - Error state tracking for UI display and caller reporting
 * - Base class for retryable invocation nodes (single source of truth)
 */

import { Node } from '@agent/node';
import {
  retryCoordinator,
  type RetryResult,
} from '@agent/runtime/RetryRequestCoordinator';
import { formatProviderHttpError } from '@common/errors/sdkErrorUtils';
import type { AgentLogger } from '@logger/AgentLogger';
import { MESSAGE_TYPES } from '@logger/messageTypes';
import {
  getModelRetryBackoffMs,
  getModelRetryMaxAttempts,
} from '@utils/config';
import { bus } from '@eventBus/ProgressEventBus';

/** Timeout for manual retry wait (5 minutes) - used by retryPrompt implementations */
const MANUAL_RETRY_TIMEOUT_MS = 5 * 60 * 1000;

// ============================================================================
// Types
// ============================================================================

/**
 * Error information for retry handling.
 */
export interface RetryErrorInfo {
  message: string;
  retryable: boolean;
}

/**
 * Retry state for tracking errors across the retry flow.
 * Used to communicate error details to callers and UI.
 */
export interface RetryState {
  /** Information about the last error, if any. */
  lastError?: RetryErrorInfo;
}

// ============================================================================
// PocketFlow Node Configuration
// ============================================================================

/**
 * Configuration for PocketFlow Node retry behavior.
 * Used internally by RetryableInvocationNode.
 */
interface NodeRetryConfig {
  /**
   * Total number of attempts, NOT the number of retries.
   * For example, maxRetries=3 means: 1 initial attempt + 2 retries.
   * Pass directly to Node constructor as maxRetries.
   */
  maxRetries: number;
  /** Wait time between retries in seconds. Pass to Node constructor as wait. */
  wait: number;
}

/**
 * Gets PocketFlow Node retry configuration from user settings.
 * Used internally by RetryableInvocationNode constructor.
 */
function getNodeRetryConfig(): NodeRetryConfig {
  const maxAutoAttempts = getModelRetryMaxAttempts() ?? 0;
  const backoffMs = getModelRetryBackoffMs() ?? 1000;

  return {
    // maxRetries = initial attempt (1) + auto-retry attempts
    maxRetries: 1 + Math.max(0, maxAutoAttempts),
    // Convert milliseconds to seconds for PocketFlow Node
    wait: backoffMs / 1000,
  };
}

// ============================================================================
// State management
// ============================================================================

/**
 * Creates initial retry state.
 */
export function createRetryState(): RetryState {
  return {
    lastError: undefined,
  };
}

/**
 * Clears error state. Used internally by handleInvocationResult.
 */
function clearRetryError(state: RetryState): void {
  state.lastError = undefined;
}

/**
 * Records an error in retry state. Used internally by handleInvocationResult.
 */
function recordRetryError(state: RetryState, error: RetryErrorInfo): void {
  state.lastError = error;
}

/**
 * Result from manual retry prompt.
 */
interface ManualRetryPromptResult {
  /** Whether to retry (true) or proceed to fallback (false) */
  shouldRetry: boolean;
  /** Whether the user explicitly cancelled (only set when shouldRetry is false) */
  userCancelled: boolean;
}

// ============================================================================
// Base invocation result type (single source of truth)
// ============================================================================

/**
 * Base result type for model/tool invocation.
 * - Success: Contains response from model (TSuccess type)
 * - Failed: When all retries exhausted or non-retryable error (records lastError)
 * - Cancelled: When user cancelled manual retry (does NOT record lastError)
 * - Skipped: When shouldStop is true before invocation
 *
 * This discriminated union is the single source of truth for invocation results.
 * Both ResponseModelInvocationNode and ToolUseCallNode use this pattern.
 */
export type InvocationResult<TSuccess> =
  | ({ kind: 'success' } & TSuccess)
  | { kind: 'failed'; message: string }
  | { kind: 'cancelled' }
  | { kind: 'skipped' };

// ============================================================================
// Retryable Invocation Node Base Class (single source of truth)
// ============================================================================

/**
 * Services interface for RetryableInvocationNode.
 * Subclasses return their own service types that conform to this shape.
 *
 * Uses flattened structure - options fields are directly on services.
 */
interface RetryableNodeServices {
  context: { streamId: string };
  logger: AgentLogger;
  setAbortController: (ac: AbortController | null) => void;
}

/**
 * Type constraint for Node params - must be an object-like type.
 * Matches the NonIterableObject constraint used by PocketFlow Node.
 */
type NodeParams = Partial<Record<string, unknown>> & {
  [Symbol.iterator]?: never;
};

/**
 * Base class for model/tool invocation nodes with retry support.
 *
 * This class provides the single source of truth for:
 * - User cancellation tracking (_userCancelled flag)
 * - Clone state reset
 * - Dynamic retry config refresh
 * - Manual retry prompt handling
 * - Fallback result generation
 *
 * Subclasses must implement:
 * - getOperationName(): Operation name for logging (e.g., 'Model invocation')
 * - getServices(): Access to options containing streamId and logger
 * - prep(): Extract data from shared for exec()
 * - exec(): Perform the actual invocation
 * - post(): Apply side effects from exec result
 *
 * @example
 * ```typescript
 * class MyInvocationNode extends RetryableInvocationNode<MyShared, MyParams> {
 *   getOperationName(): string { return 'My operation'; }
 *   getServices() { return this._params.services; }
 *   async exec(prepRes: PrepResult): Promise<InvocationResult<SuccessData>> { ... }
 * }
 * ```
 */
export abstract class RetryableInvocationNode<
  S,
  P extends NodeParams = NodeParams,
  Svc extends RetryableNodeServices = RetryableNodeServices,
> extends Node<S, P, Svc> {
  /**
   * Tracks if user cancelled manual retry (to distinguish from actual failures).
   *
   * Design note: We use instance state rather than a UserCancelledError type because:
   * 1. PocketFlow's retry loop catches all errors - we can't distinguish error types there
   * 2. execFallback() receives the original error, not a wrapped cancellation
   * 3. The flag is set in retryPrompt() and read in execFallback() - clear data flow
   * 4. Manual retry protection (MAX_MANUAL_RETRIES=100) is in Node._exec()
   */
  protected _userCancelled = false;

  constructor() {
    const config = getNodeRetryConfig();
    super(config.maxRetries, config.wait);
  }

  /**
   * Operation name for logging (e.g., 'Model invocation', 'Tool-use call').
   * Used in retry prompts and error messages.
   */
  protected abstract getOperationName(): string;

  /**
   * Access services containing streamId and logger.
   * Uses this.services which is typed via the Svc generic parameter.
   */
  protected getServices(): Svc {
    return this.services;
  }

  /**
   * Reset user-cancelled flag on clone to prevent stale state.
   *
   * IMPORTANT: BaseNode.clone() uses Object.assign (shallow copy).
   * - Primitive properties like _userCancelled are copied by value (safe)
   * - Object/array properties would share references (unsafe)
   *
   * If subclasses add object/array properties, they MUST override clone()
   * to deep-copy them. Currently RetryableInvocationNode only has primitives.
   */
  clone(): this {
    const cloned = super.clone();
    cloned._userCancelled = false;
    return cloned;
  }

  /**
   * Wraps an async operation with automatic AbortController lifecycle management.
   *
   * Provides single source of truth for the abort controller pattern that was
   * previously duplicated across ResponseModelInvocationNode and ToolUseCallNode.
   *
   * Handles:
   * - Create AbortController and register with Node.signal for retry detection
   * - Call setAbortController(controller) on services to enable interruption
   * - Execute the operation with the signal
   * - Cleanup: call setAbortController(null) in finally block
   *
   * @param operation - Async operation that uses the AbortController's signal
   * @returns Result of the operation
   *
   * @example
   * ```typescript
   * async exec(prepRes: PrepResult): Promise<Result> {
   *   if (prepRes.shouldStop) return { kind: 'skipped' };
   *   return this.withAbortController(async (signal) => {
   *     const response = await modelHandler.createResponse({ signal });
   *     return { kind: 'success', response };
   *   });
   * }
   * ```
   */
  protected async withAbortController<T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const abortController = new AbortController();
    // Set signal on Node so retry loop can detect user cancellation
    this.signal = abortController.signal;
    const services = this.getServices();
    services.setAbortController(abortController);
    try {
      return await operation(abortController.signal);
    } finally {
      // Clear both references to allow GC and prevent stale state
      this.signal = undefined;
      services.setAbortController(null);
    }
  }

  /**
   * Read fresh retry config before starting the retry loop.
   *
   * This enables config changes (e.g., user adjusting retry settings)
   * to take effect without rebuilding the flow.
   *
   * ## Why mutating instance state is safe here:
   * 1. PocketFlow clones nodes before each execution (see Flow.run)
   * 2. Config is read at the START of _exec(), before any retries
   * 3. Same config applies to all retry attempts within one execution
   * 4. Flows are single-threaded per request - no concurrent mutation
   *
   * The mutation pattern is intentional: it allows dynamic config while
   * keeping the Node API simple (maxRetries/wait are base class fields).
   */
  async _exec(prepRes: unknown): Promise<unknown> {
    const config = getNodeRetryConfig();
    this.maxRetries = config.maxRetries;
    this.wait = config.wait;
    return super._exec(prepRes);
  }

  /**
   * Manual retry prompt - called when auto-retries are exhausted.
   * Shows retry UI for retryable errors and waits for user action.
   *
   * Flow:
   * 1. Format error and check if retryable
   * 2. If not retryable, return false immediately (no UI)
   * 3. Log error and emit waiting status
   * 4. Wait for user action via RetryRequestCoordinator
   * 5. Return whether to retry
   *
   * NOTE: This must be a regular method (not an arrow function) because
   * Node.clone() uses Object.assign. Arrow functions capture `this` at
   * construction time, so they would reference the original instance
   * instead of the clone after cloning.
   *
   * @returns true to restart auto-retry loop, false to proceed to execFallback
   */
  async retryPrompt(_prepRes: unknown, error: Error): Promise<boolean> {
    const result = await this.handleManualRetryPrompt(error);

    // Track user cancellation to distinguish from actual failures in execFallback.
    // Note: This flag is only set when user explicitly cancelled a retryable error.
    // Non-retryable errors skip the retry UI and go directly to execFallback,
    // where _userCancelled will be false (correctly treating them as failures).
    if (result.userCancelled) {
      this._userCancelled = true;
    }

    return result.shouldRetry;
  }

  /**
   * Handles the manual retry prompt UI flow.
   * Extracted as a protected method for better cohesion with retry logic.
   */
  protected async handleManualRetryPrompt(
    error: Error,
  ): Promise<ManualRetryPromptResult> {
    const services = this.getServices();
    const operationName = this.getOperationName();
    const streamId = services.context.streamId;
    const logger = services.logger;

    // Format error to check if retryable
    const formatted = formatProviderHttpError(error);

    // If not retryable, don't show UI - go straight to execFallback
    if (!formatted.retryable) {
      return { shouldRetry: false, userCancelled: false };
    }

    // Log the error before showing retry UI
    logger.logErrorData(`${operationName} failed: ${formatted.message}`, {
      message: formatted.message,
      statusCode: formatted.statusCode,
      retryable: formatted.retryable,
    });

    // Emit waiting status to UI
    bus.emit('updateStreamStatus', { stream: streamId, status: 'waiting' });

    // Wait for user action via the Promise-based coordinator
    const result: RetryResult = await retryCoordinator.waitForUserAction(
      streamId,
      {
        operation: operationName,
        errorMessage: formatted.message,
        logger,
        timeoutMs: MANUAL_RETRY_TIMEOUT_MS,
      },
    );

    if (result.action === 'retry') {
      logger.debug('Manual retry triggered');
      bus.emit('updateStreamStatus', { stream: streamId, status: 'resuming' });
      return { shouldRetry: true, userCancelled: false };
    }

    // User cancelled or timeout
    logger.info('Retry cancelled by user', {
      messageType: MESSAGE_TYPES.PROGRESS_STATUS,
    });
    bus.emit('updateStreamStatus', { stream: streamId, status: 'stopped' });
    return { shouldRetry: false, userCancelled: true };
  }

  /**
   * Called by PocketFlow Node when retryPrompt returns false.
   * Returns 'cancelled' if user cancelled, 'failed' otherwise.
   *
   * Subclasses should call this from their execFallback implementation.
   */
  protected getFallbackResult(
    error: Error,
  ): { kind: 'cancelled' } | { kind: 'failed'; message: string } {
    // User cancelled manual retry - return 'cancelled' (not 'failed')
    // This ensures lastError is NOT recorded, distinguishing cancellation from failure
    if (this._userCancelled) {
      return { kind: 'cancelled' };
    }

    const formatted = formatProviderHttpError(error);
    // Log final failure (only for non-retryable errors - retryable ones were logged in retryPrompt)
    if (!formatted.retryable) {
      const services = this.getServices();
      services.logger.logErrorData(
        `${this.getOperationName()} failed (not retryable): ${formatted.message}`,
        {
          message: formatted.message,
          statusCode: formatted.statusCode,
          retryable: formatted.retryable,
        },
      );
    }
    return { kind: 'failed', message: formatted.message };
  }
}

// ============================================================================
// Shared post() helpers for invocation result handling
// ============================================================================

/**
 * Error message for empty response failure.
 * Used when model returns null/undefined response (network issue, server error, etc.)
 */
const EMPTY_RESPONSE_ERROR_MESSAGE =
  'Model response was empty or aborted; this may indicate a server issue or network problem.';

/**
 * Options for handling invocation result in post().
 */
interface InvocationResultHandlerOptions {
  /** Logger for debug/warning messages */
  logger: AgentLogger;
  /** Operation name for log messages */
  operationName: string;
}

/**
 * Handles common invocation result cases in post().
 *
 * This is the single source of truth for handling:
 * - 'skipped': Logs and returns null (COMPLETE)
 * - 'cancelled': Clears retry error, sets state, returns null (COMPLETE)
 * - 'failed': Records retry error, sets state, returns null (COMPLETE)
 * - 'success' with empty response: Records error, sets state, returns null (COMPLETE)
 * - 'success' with response: Clears error, returns the narrowed success result
 *
 * IMPORTANT: This fixes the empty response misclassification bug by recording
 * an error when response is empty, preventing it from being detected as
 * user cancellation (which requires lastError to be undefined).
 *
 * @param result - The invocation result to handle
 * @param state - Mutable cycle state (shouldStop, endTurn will be set)
 * @param retryState - Mutable retry state (lastError will be set/cleared)
 * @param options - Logger and operation name for messages
 * @returns The narrowed success result if successful, null if flow should complete
 */
export function handleInvocationResult<T extends { response: unknown }>(
  result: InvocationResult<T>,
  state: { shouldStop: boolean; endTurn: boolean },
  retryState: RetryState,
  options: InvocationResultHandlerOptions,
): (T & { kind: 'success' }) | null {
  const { logger, operationName } = options;

  // Handle skipped (shouldStop was true before invocation)
  if (result.kind === 'skipped') {
    logger.debug(`${operationName} skipped: shouldStop was already true`);
    return null;
  }

  // Handle user cancellation (do NOT record error - distinguishes from failure)
  if (result.kind === 'cancelled') {
    // Clear any previous error to ensure userCancelled detection works
    clearRetryError(retryState);
    state.shouldStop = true;
    state.endTurn = false; // Not a normal completion
    return null;
  }

  // Handle failure (all retries exhausted or non-retryable error)
  if (result.kind === 'failed') {
    // Record error for caller access
    recordRetryError(retryState, {
      message: result.message,
      retryable: false, // Already exhausted retries
    });
    state.shouldStop = true;
    state.endTurn = false; // Not a normal completion
    return null;
  }

  // At this point, result.kind === 'success' (all other cases handled above)
  // Handle success with empty response (server/network issue)
  // IMPORTANT: Record an error to prevent misclassification as user cancellation
  if (!result.response) {
    logger.warn(EMPTY_RESPONSE_ERROR_MESSAGE);
    recordRetryError(retryState, {
      message: EMPTY_RESPONSE_ERROR_MESSAGE,
      retryable: false,
    });
    state.shouldStop = true;
    state.endTurn = false; // Not a normal completion
    return null;
  }

  // Success with valid response - clear any previous error
  clearRetryError(retryState);
  return result;
}
