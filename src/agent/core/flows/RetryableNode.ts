/**
 * Base class for flow nodes that support retry with backoff.
 *
 * Extends BaseNode to provide automatic retry logic via flow transitions
 * rather than nested loops. When an operation fails:
 *
 * 1. If auto-retry is available → RETRY transition (loops back to self)
 * 2. If manual retry is available → AWAIT_RETRY transition (pauses for user)
 * 3. Otherwise → COMPLETE transition with error state
 *
 * This replaces the executeWithRequestRetry pattern with a flow-native approach.
 */

import { BaseNode } from '@agent/node';
import { formatProviderHttpError } from '@common/errors/sdkErrorUtils';
import type { AgentLogger } from '@logger/AgentLogger';
import { MESSAGE_TYPES } from '@logger/messageTypes';
import { sleep } from '@utils/helpers';

import { FlowTransition } from './FlowTransitions';
import {
  RetryState,
  computeBackoffDelay,
  recordRetryError,
  clearRetryError,
  shouldAutoRetry,
  shouldOfferManualRetry,
} from './RetryState';

/**
 * Context required for retryable nodes.
 */
export interface RetryableContext {
  retryState: RetryState;
  logger: AgentLogger;
  signal?: AbortSignal;
}

/**
 * Result from a retryable operation.
 */
export interface RetryableResult<T> {
  success: boolean;
  value?: T;
  error?: unknown;
}

/**
 * Base class for nodes that perform retryable operations.
 *
 * Subclasses implement `execRetryable()` instead of `exec()`. The base class
 * handles retry state management and flow transitions.
 */
export abstract class RetryableNode<
  C extends RetryableContext,
  P = unknown,
  R = unknown,
> extends BaseNode<C> {
  /**
   * Implement this method to perform the actual operation.
   * Throw an error to trigger retry logic.
   */
  protected abstract execRetryable(context: C, prepRes: P): Promise<R>;

  /**
   * Override to customize error classification.
   * Default uses formatProviderHttpError for HTTP error detection.
   */
  protected classifyError(
    error: unknown,
  ): { message: string; statusCode?: number } {
    return formatProviderHttpError(error);
  }

  /**
   * Override to perform setup before the operation.
   */
  async prep(shared: C): Promise<P> {
    return undefined as unknown as P;
  }

  /**
   * Executes the operation with retry state tracking.
   */
  async exec(prepRes: P): Promise<RetryableResult<R>> {
    // Note: We need access to shared context for retry state.
    // This is a workaround since exec() doesn't receive shared directly.
    // The actual retry state update happens in _run override.
    try {
      const value = await this.execRetryable(
        this._currentContext!,
        prepRes,
      );
      return { success: true, value };
    } catch (error) {
      return { success: false, error };
    }
  }

  /**
   * Routes to appropriate transition based on retry state.
   */
  async post(
    shared: C,
    prepRes: P,
    execRes: RetryableResult<R>,
  ): Promise<string | undefined> {
    const { retryState, logger } = shared;

    if (execRes.success) {
      clearRetryError(retryState);
      return this.onSuccess(shared, prepRes, execRes.value as R);
    }

    // Record the error
    const classified = this.classifyError(execRes.error);
    recordRetryError(retryState, classified.message, classified.statusCode);

    // Check abort signal
    if (shared.signal?.aborted) {
      logger.warn('Operation aborted', {
        messageType: MESSAGE_TYPES.PROGRESS_STATUS,
      });
      return FlowTransition.COMPLETE;
    }

    // Determine retry strategy
    if (shouldAutoRetry(retryState)) {
      const delay = computeBackoffDelay(retryState);
      logger.warn(
        `Retrying after ${delay}ms (attempt ${retryState.attemptCount}/${retryState.maxAutoAttempts}): ${classified.message}`,
        {
          messageType: MESSAGE_TYPES.PROGRESS_STATUS,
          data: {
            attempt: retryState.attemptCount,
            maxAttempts: retryState.maxAutoAttempts,
            statusCode: classified.statusCode,
          },
        },
      );
      await sleep(delay);
      return FlowTransition.RETRY;
    }

    if (shouldOfferManualRetry(retryState)) {
      retryState.awaitingManualRetry = true;
      logger.error(`Operation failed: ${classified.message}`, {
        messageType: MESSAGE_TYPES.PROGRESS_STATUS,
        data: {
          statusCode: classified.statusCode,
          retryable: true,
        },
      });
      return FlowTransition.AWAIT_RETRY;
    }

    // Non-retryable error
    logger.error(`Operation failed (not retryable): ${classified.message}`, {
      messageType: MESSAGE_TYPES.PROGRESS_STATUS,
      data: {
        statusCode: classified.statusCode,
        retryable: false,
      },
    });
    return this.onError(shared, prepRes, execRes.error);
  }

  /**
   * Override to customize success handling.
   * Default returns undefined to continue to next node.
   */
  protected async onSuccess(
    shared: C,
    prepRes: P,
    result: R,
  ): Promise<string | undefined> {
    return undefined;
  }

  /**
   * Override to customize non-retryable error handling.
   * Default returns COMPLETE.
   */
  protected async onError(
    shared: C,
    prepRes: P,
    error: unknown,
  ): Promise<string | undefined> {
    return FlowTransition.COMPLETE;
  }

  // Internal: Store context for use in exec()
  private _currentContext?: C;

  /**
   * Override _run to track retry attempts and store context.
   */
  async _run(shared: C): Promise<string | undefined> {
    this._currentContext = shared;
    shared.retryState.attemptCount++;

    try {
      return await super._run(shared);
    } finally {
      this._currentContext = undefined;
    }
  }
}
