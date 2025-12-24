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
export const MANUAL_RETRY_TIMEOUT_MS = 5 * 60 * 1000;

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
 * Use these values when constructing invocation nodes.
 */
export interface NodeRetryConfig {
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
 * Returns values suitable for passing to Node constructor.
 *
 * @example
 * ```typescript
 * class MyInvocationNode extends Node<S, P> {
 *   constructor() {
 *     const config = getNodeRetryConfig();
 *     super(config.maxRetries, config.wait);
 *   }
 * }
 * ```
 */
export function getNodeRetryConfig(): NodeRetryConfig {
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
 * Clears error state. Used for:
 * - After successful invocation (to reset for next operation)
 * - After manual retry triggered (to start fresh)
 * - After user cancellation (to distinguish from error failure)
 */
export function clearRetryError(state: RetryState): void {
  state.lastError = undefined;
}

/**
 * Records an error in retry state.
 */
export function recordRetryError(
  state: RetryState,
  error: RetryErrorInfo,
): void {
  state.lastError = error;
}

// ============================================================================
// Shared retry prompt helper
// ============================================================================

/**
 * Options for the manual retry prompt helper.
 */
export interface ManualRetryPromptOptions {
  /** Operation name for logging (e.g., 'Model invocation', 'Tool-use call') */
  operationName: string;
  /** Stream ID for status updates */
  streamId: string;
  /** Logger instance */
  logger: AgentLogger;
}

/**
 * Result from manual retry prompt helper.
 */
export interface ManualRetryPromptResult {
  /** Whether to retry (true) or proceed to fallback (false) */
  shouldRetry: boolean;
  /** Whether the user explicitly cancelled (only set when shouldRetry is false) */
  userCancelled: boolean;
}

/**
 * Shared helper for manual retry prompt logic.
 *
 * This extracts the common flow used by both ResponseModelInvocationNode
 * and ToolUseCallNode:
 * 1. Format error and check if retryable
 * 2. If not retryable, return immediately (no UI)
 * 3. Log error and emit waiting status
 * 4. Wait for user action via RetryRequestCoordinator
 * 5. Return whether to retry and if user cancelled
 *
 * @param error - The error that triggered the retry prompt
 * @param options - Options including operation name, stream ID, and logger
 * @returns Result indicating whether to retry and if user cancelled
 */
export async function handleManualRetryPrompt(
  error: Error,
  options: ManualRetryPromptOptions,
): Promise<ManualRetryPromptResult> {
  const { operationName, streamId, logger } = options;

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
 * Services interface required by RetryableInvocationNode.
 * Subclasses must ensure their params.services has this shape.
 */
export interface RetryableNodeServices {
  options: {
    context: { streamId: string };
    logger: AgentLogger;
  };
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
export abstract class RetryableInvocationNode<S, P extends NodeParams = NodeParams> extends Node<S, P> {
  /** Tracks if user cancelled manual retry (to distinguish from actual failures) */
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
   * Subclasses implement this to access their specific params structure.
   */
  protected abstract getServices(): RetryableNodeServices;

  /**
   * Reset user-cancelled flag on clone to prevent stale state.
   *
   * This override is necessary because BaseNode.clone() uses Object.assign,
   * which copies instance properties including _userCancelled. Without this
   * reset, a cloned node would inherit the cancelled state from a previous
   * execution, causing incorrect behavior in execFallback().
   */
  clone(): this {
    const cloned = super.clone();
    cloned._userCancelled = false;
    return cloned;
  }

  /**
   * Read fresh retry config before starting the retry loop.
   *
   * This enables config changes to take effect without rebuilding the flow.
   * Config is read once at the start of _exec(), before any retries begin,
   * so the same config applies to all retry attempts within a single execution.
   *
   * Note: PocketFlow flows are single-threaded per request, so concurrent
   * mutation is not a concern here.
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
   * NOTE: This must be a regular method (not an arrow function) because
   * Node.clone() uses Object.assign. Arrow functions capture `this` at
   * construction time, so they would reference the original instance
   * instead of the clone after cloning.
   *
   * @returns true to restart auto-retry loop, false to proceed to execFallback
   */
  async retryPrompt(_prepRes: unknown, error: Error): Promise<boolean> {
    const services = this.getServices();

    const result = await handleManualRetryPrompt(error, {
      operationName: this.getOperationName(),
      streamId: services.options.context.streamId,
      logger: services.options.logger,
    });

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
   * Called by PocketFlow Node when retryPrompt returns false.
   * Returns 'cancelled' if user cancelled, 'failed' otherwise.
   *
   * Subclasses should call this from their execFallback implementation.
   */
  protected getFallbackResult(error: Error): { kind: 'cancelled' } | { kind: 'failed'; message: string } {
    // User cancelled manual retry - return 'cancelled' (not 'failed')
    // This ensures lastError is NOT recorded, distinguishing cancellation from failure
    if (this._userCancelled) {
      return { kind: 'cancelled' };
    }

    const formatted = formatProviderHttpError(error);
    // Log final failure (only for non-retryable errors - retryable ones were logged in retryPrompt)
    if (!formatted.retryable) {
      const services = this.getServices();
      services.options.logger.logErrorData(
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
export const EMPTY_RESPONSE_ERROR_MESSAGE =
  'Model response was empty or aborted; this may indicate a server issue or network problem.';

/**
 * Options for handling invocation result in post().
 */
export interface InvocationResultHandlerOptions {
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

  // Success with valid response - clear any previous error and return narrowed type
  clearRetryError(retryState);
  return result as T & { kind: 'success' };
}
