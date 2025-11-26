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
  // Default to 1 attempt (no automatic retries) unless explicitly configured
  const configuredMaxAttempts =
    options.maxAttempts ?? getModelRetryMaxAttempts();
  const maxAttempts = Math.max(
    1,
    configuredMaxAttempts ?? DEFAULT_MODEL_RETRY_ATTEMPTS,
  );
  const baseDelayMs =
    options.baseDelayMs ??
    getModelRetryBackoffMs() ??
    DEFAULT_MODEL_RETRY_BACKOFF_MS;
  const allowManualRetry = options.enableManualRetry ?? true;
  const manualRetryKey = options.manualRetryKey ?? options.logger.channelId;

  if (allowManualRetry && manualRetryKey) {
    clearManualRetry(manualRetryKey);
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    options.onAttemptStart?.(attempt);

    if (options.signal?.aborted) {
      throw options.signal.reason ?? new Error('The request was aborted.');
    }

    try {
      return await request();
    } catch (error) {
      const formatted = formatProviderHttpError(error);
      const statusCode = formatted.statusCode;
      const retryable = attempt < maxAttempts && shouldRetry(statusCode);
      const context = {
        ...formatted,
        attempt,
        maxAttempts,
        model: options.model,
        operation: options.operation,
      };

      if (!retryable) {
        if (allowManualRetry && manualRetryKey) {
          registerManualRetry(manualRetryKey, {
            operation: options.operation,
            logger: options.logger,
            model: options.model,
            run: () =>
              executeWithRequestRetry(
                {
                  ...options,
                  enableManualRetry: false,
                },
                request,
              ),
          });
        }

        options.logger.error(
          `Error in ${options.operation}: ${formatted.message}`,
          {
            messageType: MESSAGE_TYPES.PROGRESS_STATUS,
            data: context,
          },
        );
        throw error;
      }

      options.logger.warn(
        `Retrying ${options.operation} after failure (${attempt}/${maxAttempts}): ${formatted.message}`,
        {
          messageType: MESSAGE_TYPES.PROGRESS_STATUS,
          data: { ...context, error: getSdkErrorMessage(error) },
        },
      );

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
