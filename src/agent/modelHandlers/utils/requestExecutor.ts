/**
 * Request execution utilities for model handlers.
 *
 * NOTE: Retry logic is handled at the flow level (ResponseCycleFlow/ToolUseCycleFlow).
 * Error logging follows the "log at the boundary" principle - errors are NOT logged here.
 * The final fallback handler (RetryState.applyFallbackResult) is the single source of truth
 * for error logging, preventing duplicate log entries as errors propagate up the stack.
 */

/**
 * Options for request execution.
 */
export interface RequestExecutionOptions {
  /** Operation name for error context (e.g., "model response", "file upload") */
  operation: string;
  /** Model name for diagnostics */
  model?: string;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Callback when attempt starts (always called with 1) */
  onAttemptStart?: (attempt: number) => void;
}

/**
 * Executes a request with abort handling.
 *
 * Error logging follows the "log at the boundary" principle:
 * - This function does NOT log errors
 * - Errors propagate up to the fallback handler which logs once
 * - This prevents the same error being logged at multiple abstraction layers
 *
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

  return await request();
}
