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
 */

import type { ErrorLogContext } from '@common/errors/sdkErrorUtils';
import {
  getModelRetryBackoffMs,
  getModelRetryMaxAttempts,
} from '@utils/config';

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
  statusCode?: number;
  retryable: boolean;
  /** Operation context from error enrichment (e.g., operation name, model) */
  context?: ErrorLogContext;
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
