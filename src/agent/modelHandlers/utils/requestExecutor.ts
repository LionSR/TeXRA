/**
 * Request execution utilities for model handlers.
 *
 * NOTE: Retry logic is handled by PocketFlow Node (maxRetries, wait, retryPrompt).
 * Error logging follows the "log at the boundary" principle:
 * - Errors are enriched with operation context here (not logged)
 * - Node's retryPrompt/execFallback logs once with full context
 * - This prevents duplicate log entries while preserving where errors originated
 */

import { enrichError } from '@common/errors/sdkErrorUtils';

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
 * Executes a request with error enrichment.
 *
 * Error handling follows the "log at the boundary" principle:
 * - This function enriches errors with operation context (does NOT log)
 * - Errors propagate up to the fallback handler which logs once with full context
 * - This preserves where errors originated without duplicate logging
 *
 * Abort handling: SDKs throw their own APIUserAbortError when signal is aborted.
 * We don't pre-check here to let the SDK handle it with proper error types.
 *
 * Retry logic is handled at the flow level, not here.
 */
export async function executeRequest<T>(
  options: RequestExecutionOptions,
  request: () => Promise<T> | T,
): Promise<T> {
  options.onAttemptStart?.(1);

  try {
    return await request();
  } catch (error) {
    // Enrich error with operation context (no logging - just attach metadata)
    throw enrichError(error, {
      operation: options.operation,
      model: options.model,
    });
  }
}
