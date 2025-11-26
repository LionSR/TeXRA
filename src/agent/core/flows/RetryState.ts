/**
 * Retry state management for flow-based retry handling.
 *
 * Instead of storing retry callbacks in a global Map, retry state lives
 * in the flow context and transitions are handled via FlowTransition values.
 */

import {
  getModelRetryBackoffMs,
  getModelRetryMaxAttempts,
  DEFAULT_MODEL_RETRY_ATTEMPTS,
  DEFAULT_MODEL_RETRY_BACKOFF_MS,
} from '@utils/config';

const RETRYABLE_NON_5XX_STATUS_CODES = new Set([408, 429]);

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

/**
 * Creates initial retry state with sensible defaults from configuration.
 */
export function createRetryState(config?: RetryStateConfig): RetryState {
  const configuredMaxAttempts = config?.maxAutoAttempts ?? getModelRetryMaxAttempts();
  const configuredBackoffMs = config?.backoffMs ?? getModelRetryBackoffMs();

  return {
    attemptCount: 0,
    maxAutoAttempts: Math.max(1, configuredMaxAttempts ?? DEFAULT_MODEL_RETRY_ATTEMPTS),
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
 */
export function shouldAutoRetry(state: RetryState): boolean {
  if (!state.lastError?.retryable) {
    return false;
  }
  return state.attemptCount < state.maxAutoAttempts;
}

/**
 * Determines if manual retry should be offered to the user.
 */
export function shouldOfferManualRetry(state: RetryState): boolean {
  return Boolean(state.lastError?.retryable) && !shouldAutoRetry(state);
}

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

/**
 * Clears error state after successful operation.
 */
export function clearRetryError(state: RetryState): void {
  state.lastError = undefined;
  state.awaitingManualRetry = false;
}
