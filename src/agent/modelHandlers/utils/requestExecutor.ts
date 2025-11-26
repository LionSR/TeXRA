/**
 * @deprecated Retry logic has been moved to flow-based handling in RetryState.ts.
 * This module now just executes requests without retry - the ResponseCycleFlow
 * and ToolUseCycleFlow handle all retry logic at the flow level.
 */

import type { AgentLogger } from '@logger/AgentLogger';

interface RequestRetryOptions {
  logger: AgentLogger;
  operation: string;
  model?: string;
  signal?: AbortSignal;
  /** @deprecated Ignored - retry handled at flow level */
  maxAttempts?: number;
  /** @deprecated Ignored - retry handled at flow level */
  baseDelayMs?: number;
  /** @deprecated Ignored - retry handled at flow level */
  enableManualRetry?: boolean;
  /** @deprecated Ignored - retry handled at flow level */
  manualRetryKey?: string;
  onAttemptStart?: (attempt: number) => void;
}

/**
 * Executes a request without retry logic.
 * Retry is handled at the flow level by ResponseCycleFlow/ToolUseCycleFlow.
 */
export async function executeWithRequestRetry<T>(
  options: RequestRetryOptions,
  request: () => Promise<T> | T,
): Promise<T> {
  options.onAttemptStart?.(1);

  if (options.signal?.aborted) {
    throw options.signal.reason ?? new Error('The request was aborted.');
  }

  return request();
}

interface StreamingRetryOptions<T> extends RequestRetryOptions {
  create: () => Promise<T>;
}

/**
 * Executes a streaming request without retry logic.
 * Retry is handled at the flow level by ResponseCycleFlow/ToolUseCycleFlow.
 */
export async function executeStreamingWithRetry<T>(
  options: StreamingRetryOptions<T>,
): Promise<T> {
  const { create, ...requestOptions } = options;
  return executeWithRequestRetry(requestOptions, create);
}
