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
import { MESSAGE_TYPES } from '@logger/messageTypes';
import { sleep } from '@utils/helpers';
import { bus } from '@eventBus/ProgressEventBus';
import { FlowTransition } from './FlowTransitions';
import { formatProviderHttpError } from '@common/errors/sdkErrorUtils';
import {
  registerManualRetry,
  clearManualRetry,
} from '@agent/runtime/ManualRetryController';
import type { AgentLogger } from '@logger/AgentLogger';

const RETRYABLE_NON_5XX_STATUS_CODES = new Set([408, 429]);

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

/**
 * Creates initial retry state with sensible defaults from configuration.
 */
export function createRetryState(config?: RetryStateConfig): RetryState {
  const configuredMaxAttempts = config?.maxAutoAttempts ?? getModelRetryMaxAttempts();
  const configuredBackoffMs = config?.backoffMs ?? getModelRetryBackoffMs();

  return {
    attemptCount: 0,
    // Allow 0 for manual-only retry (no automatic retries after first failure)
    maxAutoAttempts: Math.max(0, configuredMaxAttempts ?? DEFAULT_MODEL_RETRY_ATTEMPTS),
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
 * Clears error state and resets attempt counter after successful operation.
 * This ensures the next invocation gets a fresh retry budget.
 */
export function clearRetryError(state: RetryState): void {
  state.attemptCount = 0;
  state.lastError = undefined;
  state.awaitingManualRetry = false;
}

// ============================================================================
// Shared retry flow helpers
// ============================================================================

/**
 * Result of handleInvocationError indicating which flow transition to take.
 * When shouldStop is true, the caller should set state.shouldStop = true.
 */
export interface RetryTransitionResult {
  transition: string;
  shouldStop?: boolean;
}

/**
 * Handles an invocation error and determines the appropriate flow transition.
 * This is the shared error handling logic for both ResponseModelInvocationNode
 * and ToolUseCallNode.
 *
 * @param retryState - The retry state to update
 * @param error - The error that occurred
 * @param logger - Logger for status messages
 * @param operationName - Human-readable operation name for logs (e.g., "model invocation")
 * @returns The flow transition to take
 */
export async function handleInvocationError(
  retryState: RetryState,
  error: unknown,
  logger: AgentLogger,
  operationName: string,
): Promise<RetryTransitionResult> {
  const formatted = formatProviderHttpError(error);
  recordRetryError(retryState, formatted.message, formatted.statusCode);

  // Auto-retry available?
  if (shouldAutoRetry(retryState)) {
    const delay = computeBackoffDelay(retryState);
    logger.warn(
      `Retrying ${operationName} after ${delay}ms (attempt ${retryState.attemptCount}/${retryState.maxAutoAttempts}): ${formatted.message}`,
      {
        messageType: MESSAGE_TYPES.PROGRESS_STATUS,
        data: {
          attempt: retryState.attemptCount,
          maxAttempts: retryState.maxAutoAttempts,
          statusCode: formatted.statusCode,
        },
      },
    );
    await sleep(delay);
    return { transition: FlowTransition.RETRY };
  }

  // Manual retry available?
  if (shouldOfferManualRetry(retryState)) {
    retryState.awaitingManualRetry = true;
    logger.error(`${operationName} failed: ${formatted.message}`, {
      messageType: MESSAGE_TYPES.PROGRESS_STATUS,
      data: {
        statusCode: formatted.statusCode,
        retryable: true,
      },
    });
    return { transition: FlowTransition.AWAIT_RETRY };
  }

  // Non-retryable error
  logger.error(`${operationName} failed (not retryable): ${formatted.message}`, {
    messageType: MESSAGE_TYPES.PROGRESS_STATUS,
    data: {
      statusCode: formatted.statusCode,
      retryable: false,
    },
  });
  return { transition: FlowTransition.COMPLETE, shouldStop: true };
}

/**
 * Executes the retry wait logic, emitting status and waiting for user action.
 * Registers with ManualRetryController so the UI can trigger retry.
 * Returns 'retry' or 'cancel' based on user action.
 */
export function executeRetryWait(
  retryState: RetryState,
  retryCallbacks: RetryCallbacks,
  logger: AgentLogger,
  streamId: string,
  operationName = 'model invocation',
): Promise<'retry' | 'cancel'> {
  // Log that we're waiting for manual retry
  logger.info('Waiting for manual retry', {
    messageType: MESSAGE_TYPES.PROGRESS_STATUS,
    data: {
      error: retryState.lastError,
      awaitingManualRetry: true,
    },
  });

  // Emit waiting status to UI
  bus.emit('updateStreamStatus', {
    stream: streamId,
    status: 'waiting',
  });

  // Wait for external signal via callbacks
  return new Promise<'retry' | 'cancel'>((resolve) => {
    // Set up callbacks for direct invocation
    retryCallbacks.triggerRetry = () => {
      clearManualRetry(streamId);
      retryCallbacks.triggerRetry = undefined;
      retryCallbacks.cancelRetry = undefined;
      resolve('retry');
    };
    retryCallbacks.cancelRetry = () => {
      clearManualRetry(streamId);
      retryCallbacks.triggerRetry = undefined;
      retryCallbacks.cancelRetry = undefined;
      resolve('cancel');
    };

    // Register with ManualRetryController for UI-triggered retries
    registerManualRetry(streamId, {
      run: async () => {
        retryCallbacks.triggerRetry?.();
      },
      logger,
      operation: operationName,
    });
  });
}

/**
 * Handles the result of executeRetryWait and returns the appropriate transition.
 */
export function handleRetryWaitResult(
  result: 'retry' | 'cancel',
  retryState: RetryState,
  logger: AgentLogger,
  streamId: string,
): { transition: string; shouldStop?: boolean } {
  if (result === 'retry') {
    // Reset attempt count for fresh retry cycle
    resetRetryState(retryState);

    logger.info('Manual retry triggered', {
      messageType: MESSAGE_TYPES.PROGRESS_STATUS,
    });

    // Update status back to running
    bus.emit('updateStreamStatus', {
      stream: streamId,
      status: 'resuming',
    });

    return { transition: FlowTransition.RETRY };
  }

  // User cancelled
  logger.info('Retry cancelled by user', {
    messageType: MESSAGE_TYPES.PROGRESS_STATUS,
  });

  bus.emit('updateStreamStatus', {
    stream: streamId,
    status: 'stopped',
  });

  return { transition: FlowTransition.COMPLETE, shouldStop: true };
}
