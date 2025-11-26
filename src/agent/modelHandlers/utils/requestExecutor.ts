/**
 * @deprecated Retry logic has been moved to flow-based handling in RetryState.ts.
 * This module now just executes requests without retry; ResponseCycleFlow and
 * ToolUseCycleFlow own all retry behavior at the flow level.
 */

// Local imports - logging
import { MESSAGE_TYPES } from '@logger/messageTypes';
import type { AgentLogger } from '@logger/AgentLogger';

// Local imports - error utilities
import {
  formatProviderHttpError,
  getSdkErrorMessage,
} from '@common/errors/sdkErrorUtils';

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
  // Always report the first attempt for downstream diagnostics
  options.onAttemptStart?.(1);

  if (options.signal?.aborted) {
    throw options.signal.reason ?? new Error('The request was aborted.');
  }

  try {
    return await request();
  } catch (error) {
    const formatted = formatProviderHttpError(error);
    options.logger.error(
      `Error in ${options.operation}: ${formatted.message}`,
      {
        messageType: MESSAGE_TYPES.PROGRESS_STATUS,
        data: {
          ...formatted,
          attempt: 1,
          maxAttempts: 1,
          model: options.model,
          operation: options.operation,
          error: getSdkErrorMessage(error),
        },
      },
    );
    throw error;
  }
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
