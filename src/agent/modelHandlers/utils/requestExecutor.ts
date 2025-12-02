/**
 * Request execution utilities for model handlers.
 *
 * NOTE: Retry logic is handled at the flow level (ResponseCycleFlow/ToolUseCycleFlow).
 * These utilities provide consistent error logging and abort handling for model requests.
 */

import type { AgentLogger } from '@logger/AgentLogger';

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
    options.logger.logError(`Error in ${options.operation}`, error, {
      operation: options.operation,
      model: options.model,
    });
    throw error;
  }
}
