/**
 * Request execution utilities for model handlers.
 *
 * NOTE: Retry logic is handled at the flow level (ResponseCycleFlow/ToolUseCycleFlow).
 * These utilities provide consistent error logging and abort handling for model requests.
 */

import { MESSAGE_TYPES } from '@logger/messageTypes';
import type { AgentLogger } from '@logger/AgentLogger';
import {
  formatProviderHttpError,
  getSdkErrorMessage,
} from '@common/errors/sdkErrorUtils';

/**
 * Options for request execution.
 */
export interface RequestExecutionOptions {
  /** Logger for error reporting */
  logger: AgentLogger;
  /** Operation name for error messages (e.g., "model response", "file upload") */
  operation: string;
  /** Model name for diagnostics */
  model?: string;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Callback when attempt starts (always called with 1) */
  onAttemptStart?: (attempt: number) => void;
}

/**
 * Executes a request with consistent error logging and abort handling.
 * Retry logic is handled at the flow level, not here.
 */
export async function executeRequest<T>(
  options: RequestExecutionOptions,
  request: () => Promise<T> | T,
): Promise<T> {
  options.onAttemptStart?.(1);

  if (options.signal?.aborted) {
    throw options.signal.reason ?? new Error('The request was aborted.');
  }

  try {
    return await request();
  } catch (error) {
    const formatted = formatProviderHttpError(error);
    options.logger.error(`Error in ${options.operation}: ${formatted.message}`, {
      messageType: MESSAGE_TYPES.PROGRESS_STATUS,
      data: {
        ...formatted,
        attempt: 1,
        maxAttempts: 1,
        model: options.model,
        operation: options.operation,
        error: getSdkErrorMessage(error),
      },
    });
    throw error;
  }
}
