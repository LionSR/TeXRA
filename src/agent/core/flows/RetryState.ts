/**
 * Retry state management for manual retry handling.
 *
 * Auto-retry is handled by PocketFlow's Node class (maxRetries, wait, execFallback).
 * This module only manages error state for manual retry UI integration.
 *
 * Architecture:
 * - PocketFlow Node handles auto-retry internally via _exec() loop
 * - execFallback() is called when all auto-retries exhausted
 * - This module tracks the last error for UI display and caller reporting
 */

import type { AgentLogger } from '@logger/AgentLogger';
import { MESSAGE_TYPES } from '@logger/messageTypes';
import {
  getModelRetryBackoffMs,
  getModelRetryMaxAttempts,
} from '@utils/config';

import { FlowTransition } from './FlowTransitions';

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

/**
 * Error information for retry handling.
 */
export interface RetryErrorInfo {
  message: string;
  statusCode?: number;
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
  /** Total attempts (initial + retries). Pass to Node constructor as maxRetries. */
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
 * Resets retry state for a fresh operation.
 */
export function resetRetryState(state: RetryState): void {
  state.lastError = undefined;
}

/**
 * Clears error state after successful operation.
 * Call this after a successful invocation to reset for next operation.
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
// Fallback handling (called from Node.execFallback via post())
// ============================================================================

/**
 * Result from execFallback that post() uses to determine flow transition.
 * Discriminated union ensures type-safe handling.
 */
export type FallbackResult =
  | { outcome: 'manual_retry'; error: RetryErrorInfo }
  | { outcome: 'fail'; error: RetryErrorInfo };

/**
 * Determines fallback action after all auto-retries are exhausted.
 * Called from Node.execFallback() to decide between manual retry and failure.
 *
 * @param retryable - Whether the error is retryable (from formatProviderHttpError)
 * @param message - Error message
 * @param statusCode - HTTP status code if available
 * @returns FallbackResult for post() to handle
 */
export function determineFallbackAction(
  retryable: boolean,
  message: string,
  statusCode?: number,
): FallbackResult {
  const error: RetryErrorInfo = { message, statusCode, retryable };

  if (retryable) {
    // Error is retryable but auto-retries exhausted → offer manual retry
    return { outcome: 'manual_retry', error };
  }

  // Non-retryable error → fail immediately
  return { outcome: 'fail', error };
}

/**
 * Applies fallback result: records error, logs, and returns flow transition.
 * Called from post() after receiving FallbackResult from execFallback.
 *
 * @param result - The fallback result from determineFallbackAction
 * @param state - The retry state to update
 * @param logger - Logger for status messages
 * @param operationName - Name of the operation for log messages
 * @returns Flow transition string
 */
export function applyFallbackResult(
  result: FallbackResult,
  state: RetryState,
  logger: AgentLogger,
  operationName: string,
): string {
  // Record error in state for caller/UI access
  recordRetryError(state, result.error);

  switch (result.outcome) {
    case 'manual_retry':
      logger.error(`${operationName} failed: ${result.error.message}`, {
        messageType: MESSAGE_TYPES.PROGRESS_STATUS,
        data: { statusCode: result.error.statusCode, retryable: true },
      });
      return FlowTransition.AWAIT_RETRY;

    case 'fail':
      logger.error(
        `${operationName} failed (not retryable): ${result.error.message}`,
        {
          messageType: MESSAGE_TYPES.PROGRESS_STATUS,
          data: { statusCode: result.error.statusCode, retryable: false },
        },
      );
      return FlowTransition.COMPLETE;
  }
}
