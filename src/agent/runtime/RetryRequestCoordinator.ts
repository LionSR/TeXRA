/**
 * RetryRequestCoordinator - Promise-based coordinator for manual retry handling.
 *
 * Flow:
 * 1. Agent calls `waitForUserAction()` - returns Promise, emits 'showRetryRequest'
 * 2. User clicks retry → `triggerRetry()` → resolves Promise with 'retry'
 * 3. Or: User cancels → `cancelRetry()` → resolves Promise with 'cancel'
 * 4. Or: Timeout → auto-resolves Promise with 'timeout'
 * 5. On resolution → emits 'resolveRetryRequest' to dismiss UI
 */

import { getDefaultAgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { AgentLogger } from '@logger/AgentLogger';
import type { ProviderErrorPartial } from '@shared/schemas';
import {
  BasePromiseCoordinator,
  type CoordinatorConfig,
} from './BasePromiseCoordinator';

/**
 * Result of a retry request. Discriminated union for type-safe handling.
 * Includes optional feedback for user guidance on retry.
 */
export type RetryResult =
  | { action: 'retry'; feedback?: string }
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
  /** Timeout in milliseconds (defaults to wait indefinitely) */
  timeoutMs?: number;
  /** Structured error details for expandable display */
  errorDetails?: ProviderErrorPartial;
}

/** Payload for show event */
interface RetryShowPayload extends Record<string, unknown> {
  streamId: string;
  operation: string;
  model?: string;
  errorMessage?: string;
  errorDetails?: ProviderErrorPartial;
}

/**
 * Manages pending retry requests.
 * Extends BasePromiseCoordinator with retry-specific behavior.
 */
export class RetryRequestCoordinatorImpl extends BasePromiseCoordinator<
  RetryResult,
  RetryShowPayload
> {
  protected readonly config: CoordinatorConfig = {
    showEventName: 'showRetryRequest',
    resolveEventName: 'resolveRetryRequest',
    idFieldName: 'streamId',
  };

  /** Track logger per request for debug messages */
  private readonly loggers = new Map<string, AgentLogger>();

  protected getDefaultCancelResult(): RetryResult {
    return { action: 'cancel' };
  }

  /**
   * Wait for user action on a retry request.
   */
  waitForRetry(
    streamId: string,
    options: RetryRequestOptions,
  ): Promise<RetryResult> {
    const { logger, operation, errorMessage, model, timeoutMs, errorDetails } =
      options;

    // Store logger for this request
    this.loggers.set(streamId, logger);

    logger.debug(
      `Waiting for manual retry: ${errorMessage ?? 'unknown error'}`,
    );

    return this.waitForUserAction(
      streamId,
      { streamId, operation, model, errorMessage, errorDetails },
      {
        timeoutMs,
        onTimeout: () => {
          const timeoutMinutes = Math.round((timeoutMs ?? 0) / 60000);
          logger.warn(
            `Manual retry wait timed out after ${timeoutMinutes} minutes`,
          );
          this.loggers.delete(streamId);
          return { action: 'timeout' };
        },
      },
    );
  }

  /**
   * Trigger a retry for a stream. Called when user clicks the retry button.
   * @param streamId - The stream to retry
   * @param feedback - Optional feedback from user
   * @returns true if retry was triggered, false if no pending request
   */
  triggerRetry(streamId: string, feedback?: string): boolean {
    const logger = this.loggers.get(streamId);
    logger?.debug('Retry requested');
    this.loggers.delete(streamId);
    return this.resolveRequest(streamId, { action: 'retry', feedback });
  }

  /**
   * Cancel a retry for a stream. Called when user clicks the cancel button.
   * @param streamId - The stream to cancel
   * @returns true if cancelled, false if no pending request
   */
  cancelRetry(streamId: string): boolean {
    const logger = this.loggers.get(streamId);
    logger?.debug('Retry cancelled');
    this.loggers.delete(streamId);
    return this.resolveRequest(streamId, { action: 'cancel' });
  }

  /**
   * Clear a pending retry request.
   * Overrides base to clean up logger.
   */
  override clearRequest(streamId: string): void {
    this.loggers.delete(streamId);
    super.clearRequest(streamId);
  }

  override clearAll(): void {
    this.loggers.clear();
    super.clearAll();
  }
}

export const retryCoordinator = new RetryRequestCoordinatorImpl(
  getDefaultAgentRuntimeHost,
);
