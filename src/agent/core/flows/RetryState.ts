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

import { Node, type NonIterableObject } from '@agent/node';
import {
  retryCoordinator,
  type RetryResult,
} from '@agent/runtime/RetryRequestCoordinator';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { SupabaseClient } from '@auth/SupabaseClient';
import {
  formatProviderHttpError,
  type ProviderError,
  type RetryErrorInfo,
} from '@common/errors';
import { STREAM_STATUS } from '@common/constants/streamStatus';
import type { AgentLogger } from '@logger/AgentLogger';
import { MESSAGE_TYPES } from '@logger/messageTypes';
import {
  getModelRetryBackoffMs,
  getModelRetryMaxAttempts,
} from '@utils/config';

/**
 * Minimum retry count for background mode (at least 3 attempts before manual retry UI).
 * Background jobs may fail due to timeouts and need more automatic recovery attempts.
 */
export const BACKGROUND_MODE_MIN_RETRIES = 3;

// ============================================================================
// Error State Types (using canonical schema)
// ============================================================================

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
  streamId: string;
  logger: AgentLogger;
  setAbortController: (ac: AbortController | null) => void;
}

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
  P extends NonIterableObject = NonIterableObject,
  Svc extends RetryableNodeServices = RetryableNodeServices,
> extends Node<S, P, Svc> {
  /**
   * Tracks if user cancelled manual retry (to distinguish from failures).
   * Set in retryPrompt(), read in execFallback(). Instance state is used because
   * PocketFlow's retry loop catches all errors without distinguishing types.
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
   * Note: BaseNode.clone() shallow-copies with Object.assign. Subclasses with
   * object/array properties must override to deep-copy them.
   */
  clone(): this {
    const cloned = super.clone();
    cloned._userCancelled = false;
    return cloned;
  }

  /**
   * Wraps an async operation with AbortController lifecycle management.
   * Creates controller, registers with Node.signal, sets on services, executes
   * operation, and cleans up in finally block.
   *
   * @example
   * return this.withAbortController(async (signal) => {
   *   const response = await modelHandler.createResponse({ signal });
   *   return { kind: 'success', response };
   * });
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
      // Clear service reference to allow GC and prevent stale abort calls.
      // NOTE: We intentionally keep this.signal set so Node._exec() can check
      // isAborted after the operation throws. Node.clone() resets signal for
      // the next execution.
      services.setAbortController(null);
    }
  }

  /**
   * Check if background mode is active for this node.
   * Override in subclasses that have access to model handler.
   *
   * @returns false by default, subclasses can override to check modelHandler
   */
  protected isBackgroundModeActive(): boolean {
    return false;
  }

  /**
   * Read fresh retry config before starting the retry loop.
   * Enables config changes to take effect without rebuilding the flow.
   *
   * Mutating instance state is safe because PocketFlow clones nodes before
   * each execution and flows are single-threaded. Background mode enforces
   * minimum retries for better recovery from transient failures.
   */
  async _exec(prepRes: unknown): Promise<unknown> {
    const config = getNodeRetryConfig();
    let maxRetries = config.maxRetries;

    // Enforce minimum retries for background mode
    if (this.isBackgroundModeActive()) {
      maxRetries = Math.max(maxRetries, BACKGROUND_MODE_MIN_RETRIES);
    }

    this.maxRetries = maxRetries;
    this.wait = config.wait;
    return super._exec(prepRes);
  }

  /**
   * Manual retry prompt - called when auto-retries are exhausted.
   * Shows retry UI for retryable errors and waits for user action.
   * Must be regular method (not arrow function) for Node.clone() compatibility.
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
   *
   * For relay 401 errors, automatically refreshes the token and retries
   * without showing the manual retry UI.
   */
  protected async handleManualRetryPrompt(
    error: Error,
  ): Promise<ManualRetryPromptResult> {
    const { streamId, logger } = this.getServices();
    const operationName = this.getOperationName();
    // Format error for this method's scope (retryable error handling)
    // Note: getFallbackResult() formats separately for non-retryable errors
    // to ensure each path logs exactly once at the appropriate point
    const formatted = formatProviderHttpError(error);

    // If not retryable, don't show UI - go straight to execFallback
    if (!formatted.retryable) {
      return { shouldRetry: false, userCancelled: false };
    }

    // Auto-refresh token on relay 401 errors and retry automatically
    if (formatted.isRelayError && formatted.statusCode === 401) {
      logger.info('Relay 401 error, attempting automatic token refresh', {
        messageType: MESSAGE_TYPES.PROGRESS_STATUS,
      });
      const refreshedToken = await SupabaseClient.forceRefreshToken();
      if (refreshedToken) {
        logger.info('Token refreshed successfully, retrying automatically', {
          messageType: MESSAGE_TYPES.PROGRESS_STATUS,
        });
        return { shouldRetry: true, userCancelled: false };
      }
      // Refresh failed - fall through to manual retry UI
      logger.warn('Token refresh failed, showing manual retry UI', {
        messageType: MESSAGE_TYPES.PROGRESS_STATUS,
      });
    }

    // Log the error before showing retry UI - pass FULL formatted error
    logger.logErrorData(
      `${operationName} failed: ${formatted.message}`,
      formatted, // Pass complete ProviderError - no field loss
    );

    // Emit waiting status and wait for user action
    StreamStatusService.set(streamId, STREAM_STATUS.WAITING);
    const result: RetryResult = await retryCoordinator.waitForRetry(streamId, {
      operation: operationName,
      errorMessage: formatted.message,
      logger,
      errorDetails: formatted, // Pass complete ProviderError - no field loss
    });

    if (result.action === 'retry') {
      logger.debug('Manual retry triggered');
      StreamStatusService.set(streamId, STREAM_STATUS.RESUMING);
      return { shouldRetry: true, userCancelled: false };
    }

    // User cancelled or timeout - preserve WAITING status for resume capability
    const message =
      result.action === 'timeout'
        ? 'Retry timed out (no response)'
        : 'Retry cancelled by user';
    logger.info(message, { messageType: MESSAGE_TYPES.PROGRESS_STATUS });
    StreamStatusService.set(streamId, STREAM_STATUS.WAITING);
    return { shouldRetry: false, userCancelled: true };
  }

  /**
   * Called by PocketFlow Node when retryPrompt returns false.
   * Returns 'cancelled' if user cancelled, 'failed' otherwise.
   * Subclasses should call this from their execFallback implementation.
   */
  protected getFallbackResult(
    error: Error,
  ): { kind: 'cancelled' } | { kind: 'failed'; message: string } {
    if (this._userCancelled) {
      return { kind: 'cancelled' };
    }

    const formatted = formatProviderHttpError(error);
    // Log final failure (only for non-retryable - retryable were logged in retryPrompt)
    if (!formatted.retryable) {
      this.getServices().logger.logErrorData(
        `${this.getOperationName()} failed (not retryable): ${formatted.message}`,
        formatted, // Pass complete ProviderError - no field loss
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
 * Mark flow as stopped without normal completion.
 * Sets shouldStop=true and endTurn=false to indicate abnormal termination
 * (cancellation, failure, or empty response).
 */
function markFlowStopped(state: {
  shouldStop: boolean;
  endTurn: boolean;
}): void {
  state.shouldStop = true;
  state.endTurn = false;
}

/**
 * Handles invocation result cases in post().
 * Returns narrowed success result or null (flow complete).
 * Records error for 'failed' and empty responses, clears for 'cancelled' and success.
 */
export function handleInvocationResult<T extends { response: unknown }>(
  result: InvocationResult<T>,
  state: { shouldStop: boolean; endTurn: boolean },
  retryState: RetryState,
  options: InvocationResultHandlerOptions,
): (T & { kind: 'success' }) | null {
  const { logger, operationName } = options;

  if (result.kind === 'skipped') {
    logger.debug(`${operationName} skipped: shouldStop was already true`);
    return null;
  }

  // User cancellation - clear error (distinguishes from failure)
  if (result.kind === 'cancelled') {
    retryState.lastError = undefined;
    markFlowStopped(state);
    return null;
  }

  // Failure - record error
  if (result.kind === 'failed') {
    retryState.lastError = { message: result.message, retryable: false };
    markFlowStopped(state);
    return null;
  }

  // Empty response - record error to prevent misclassification as cancellation
  if (!result.response) {
    logger.warn(EMPTY_RESPONSE_ERROR_MESSAGE);
    retryState.lastError = {
      message: EMPTY_RESPONSE_ERROR_MESSAGE,
      retryable: false,
    };
    markFlowStopped(state);
    return null;
  }

  // Success - clear error and return
  retryState.lastError = undefined;
  return result;
}
