/**
 * Retry state management for flow-based retry handling.
 *
 * This module centralizes retry state management. Functions that mutate state
 * are clearly documented. Side effects (logging, sleeping, events) belong in
 * flow nodes.
 */

import {
  getModelRetryBackoffMs,
  getModelRetryMaxAttempts,
  DEFAULT_MODEL_RETRY_ATTEMPTS,
  DEFAULT_MODEL_RETRY_BACKOFF_MS,
} from '@utils/config';

const RETRYABLE_NON_5XX_STATUS_CODES = new Set([408, 429]);

/** Timeout for manual retry wait (5 minutes) - exported for BaseRetryWaitNode */
export const MANUAL_RETRY_TIMEOUT_MS = 5 * 60 * 1000;

// ============================================================================
// Types
// ============================================================================

/**
 * Callbacks for manual retry control.
 * Store these in your flow context to allow external triggering.
 */
export interface RetryCallbacks {
  /** Call to trigger a retry attempt. */
  triggerRetry?: () => void;
  /** Call to cancel and abort the operation. */
  cancelRetry?: () => void;
}

export interface RetryErrorInfo {
  message: string;
  statusCode?: number;
  retryable: boolean;
}

export interface RetryState {
  /** Current attempt number (1-indexed, incremented before each attempt). */
  attemptCount: number;
  /** Maximum automatic retry attempts before requiring manual intervention. */
  maxAutoAttempts: number;
  /** Base backoff delay in milliseconds (multiplied by attempt number). */
  backoffMs: number;
  /** Information about the last error, if any. */
  lastError?: RetryErrorInfo;
  /** Whether the flow is paused awaiting manual retry from user. */
  awaitingManualRetry: boolean;
}

export interface RetryStateConfig {
  maxAutoAttempts?: number;
  backoffMs?: number;
}

// ============================================================================
// Pure state creation and reset
// ============================================================================

/**
 * Creates initial retry state with sensible defaults from configuration.
 */
export function createRetryState(config?: RetryStateConfig): RetryState {
  const configuredMaxAttempts =
    config?.maxAutoAttempts ?? getModelRetryMaxAttempts();
  const configuredBackoffMs = config?.backoffMs ?? getModelRetryBackoffMs();

  return {
    attemptCount: 0,
    // Allow 0 for manual-only retry (no automatic retries after first failure)
    maxAutoAttempts: Math.max(
      0,
      configuredMaxAttempts ?? DEFAULT_MODEL_RETRY_ATTEMPTS,
    ),
    backoffMs: configuredBackoffMs ?? DEFAULT_MODEL_RETRY_BACKOFF_MS,
    lastError: undefined,
    awaitingManualRetry: false,
  };
}

/**
 * Resets retry state for a fresh operation (keeps config, clears attempt state).
 */
export function resetRetryState(state: RetryState): void {
  state.attemptCount = 0;
  state.lastError = undefined;
  state.awaitingManualRetry = false;
}

/**
 * Clears error state and resets attempt counter after successful operation.
 * This ensures the next invocation gets a fresh retry budget.
 * @mutates state.attemptCount, state.lastError, state.awaitingManualRetry
 */
export function clearRetryError(state: RetryState): void {
  state.attemptCount = 0;
  state.lastError = undefined;
  state.awaitingManualRetry = false;
}

/**
 * Increments the attempt counter before each invocation attempt.
 * Call this at the start of exec() in invocation nodes.
 * @mutates state.attemptCount
 */
export function beginAttempt(state: RetryState): void {
  state.attemptCount++;
}

// ============================================================================
// Pure predicates
// ============================================================================

/**
 * Determines if an HTTP status code is retryable (5xx or 408/429).
 */
export function isRetryableStatusCode(statusCode?: number): boolean {
  if (statusCode === undefined) {
    return false;
  }
  if (statusCode >= 500) {
    return true;
  }
  return RETRYABLE_NON_5XX_STATUS_CODES.has(statusCode);
}

/**
 * Determines if automatic retry should be attempted based on current state.
 * Uses <= so maxAutoAttempts represents the number of retry attempts allowed,
 * not total attempts (initial attempt + maxAutoAttempts retries).
 */
export function shouldAutoRetry(state: RetryState): boolean {
  if (!state.lastError?.retryable) {
    return false;
  }
  return state.attemptCount <= state.maxAutoAttempts;
}

/**
 * Determines if manual retry should be offered to the user.
 */
export function shouldOfferManualRetry(state: RetryState): boolean {
  return Boolean(state.lastError?.retryable) && !shouldAutoRetry(state);
}

// ============================================================================
// Pure computations
// ============================================================================

/**
 * Computes the backoff delay for the current attempt.
 */
export function computeBackoffDelay(state: RetryState): number {
  return state.backoffMs * state.attemptCount;
}

/**
 * Records an error in retry state.
 */
export function recordRetryError(
  state: RetryState,
  message: string,
  statusCode?: number,
): void {
  state.lastError = {
    message,
    statusCode,
    retryable: isRetryableStatusCode(statusCode),
  };
}

// ============================================================================
// Retry decision (single source of truth for retry logic)
// ============================================================================

/**
 * Result of retry strategy determination.
 * The caller handles side effects (logging, sleeping, UI events).
 */
export interface RetryDecision {
  /** The flow transition to take */
  action: 'auto_retry' | 'manual_retry' | 'fail';
  /** Backoff delay in ms (only for auto_retry) */
  delayMs?: number;
  /** Formatted error info for logging */
  error: {
    message: string;
    statusCode?: number;
    retryable: boolean;
  };
}

/**
 * Determines retry strategy after an error.
 * This is the SINGLE SOURCE OF TRUTH for retry decision logic.
 *
 * @mutates state.lastError, state.awaitingManualRetry
 * Side effects (logging, sleeping, UI events) are handled by the caller.
 */
export function determineRetryStrategy(
  state: RetryState,
  errorMessage: string,
  statusCode?: number,
): RetryDecision {
  // Record the error in state
  recordRetryError(state, errorMessage, statusCode);

  const error = {
    message: errorMessage,
    statusCode,
    retryable: state.lastError?.retryable ?? false,
  };

  // Check auto-retry first
  if (shouldAutoRetry(state)) {
    return {
      action: 'auto_retry',
      delayMs: computeBackoffDelay(state),
      error,
    };
  }

  // Check manual retry
  if (shouldOfferManualRetry(state)) {
    state.awaitingManualRetry = true;
    return {
      action: 'manual_retry',
      error,
    };
  }

  // Non-retryable failure
  return {
    action: 'fail',
    error,
  };
}
