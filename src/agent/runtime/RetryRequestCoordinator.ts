/**
 * Promise-based coordinator for manual retry handling.
 *
 * 1. Agent calls `waitForRetry()` → returns Promise, emits 'showRetryRequest'.
 * 2. User clicks retry → `triggerRetry()` → resolves Promise with 'retry'.
 *    Or:    User cancels → `cancelRetry()` → resolves Promise with 'cancel'.
 *    Or:    Timeout → auto-resolves Promise with 'timeout'.
 * 3. On resolution → emits 'resolveRetryRequest' to dismiss UI.
 */

import { getDefaultAgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { AgentLogger } from '@logger/AgentLogger';
import type { ProviderErrorPartial } from '@shared/schemas';
import {
  BasePromiseCoordinator,
  type CoordinatorConfig,
} from './BasePromiseCoordinator';

export type RetryResult =
  | { action: 'retry'; feedback?: string }
  | { action: 'cancel' }
  | { action: 'timeout' };

export interface RetryRequestOptions {
  /** Name of the operation that failed (e.g. "Model invocation"). */
  operation: string;
  /** Error message to display to the user. */
  errorMessage?: string;
  /** Model name for context. */
  model?: string;
  /** Logger for debug messages. */
  logger: AgentLogger;
  /** Timeout in milliseconds (default: wait indefinitely). */
  timeoutMs?: number;
  /** Structured error details for expandable display. */
  errorDetails?: ProviderErrorPartial;
}

interface RetryShowPayload extends Record<string, unknown> {
  streamId: string;
  operation: string;
  model?: string;
  errorMessage?: string;
  errorDetails?: ProviderErrorPartial;
}

export class RetryRequestCoordinatorImpl extends BasePromiseCoordinator<
  RetryResult,
  RetryShowPayload
> {
  protected readonly config: CoordinatorConfig = {
    showEventName: 'showRetryRequest',
    resolveEventName: 'resolveRetryRequest',
    idFieldName: 'streamId',
  };

  /** Per-stream logger captured during waitForRetry, consulted by trigger/cancel. */
  private readonly loggers = new Map<string, AgentLogger>();

  protected getDefaultCancelResult(): RetryResult {
    return { action: 'cancel' };
  }

  waitForRetry(
    streamId: string,
    options: RetryRequestOptions,
  ): Promise<RetryResult> {
    const { logger, operation, errorMessage, model, timeoutMs, errorDetails } =
      options;
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

  /** Resolve with 'retry'. Returns true if a pending request was resolved. */
  triggerRetry(streamId: string, feedback?: string): boolean {
    this.loggers.get(streamId)?.debug('Retry requested');
    this.loggers.delete(streamId);
    return this.resolveRequest(streamId, { action: 'retry', feedback });
  }

  /** Resolve with 'cancel'. Returns true if a pending request was resolved. */
  cancelRetry(streamId: string): boolean {
    this.loggers.get(streamId)?.debug('Retry cancelled');
    this.loggers.delete(streamId);
    return this.resolveRequest(streamId, { action: 'cancel' });
  }

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
