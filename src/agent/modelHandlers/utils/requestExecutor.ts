import {
  clearManualRetry,
  registerManualRetry,
} from '@agent/runtime/ManualRetryController';
// Local imports - logging
import {
  formatProviderHttpError,
  getSdkErrorMessage,
} from '@common/errors/sdkErrorUtils';
import type { AgentLogger } from '@logger/AgentLogger';
import { MESSAGE_TYPES } from '@logger/messageTypes';
import { sleep } from '@utils/helpers';
import {
  getModelRetryBackoffMs,
  getModelRetryMaxAttempts,
  DEFAULT_MODEL_RETRY_ATTEMPTS,
  DEFAULT_MODEL_RETRY_BACKOFF_MS,
} from '@utils/config';

interface RequestRetryOptions {
  logger: AgentLogger;
  operation: string;
  model?: string;
  signal?: AbortSignal;
  maxAttempts?: number;
  baseDelayMs?: number;
  enableManualRetry?: boolean;
  manualRetryKey?: string;
  onAttemptStart?: (attempt: number) => void;
}

const RETRYABLE_NON_5XX_STATUS_CODES = new Set([408, 429]);

function shouldRetry(statusCode?: number): boolean {
  if (statusCode === undefined) {
    return false;
  }
  if (statusCode >= 500) {
    return true;
  }
  return RETRYABLE_NON_5XX_STATUS_CODES.has(statusCode);
}

export async function executeWithRequestRetry<T>(
  options: RequestRetryOptions,
  request: () => Promise<T> | T,
): Promise<T> {
  // Default to 1 attempt (no automatic retries) unless explicitly configured
  const configuredMaxAttempts = options.maxAttempts ?? getModelRetryMaxAttempts();
  const maxAttempts = Math.max(1, configuredMaxAttempts ?? DEFAULT_MODEL_RETRY_ATTEMPTS);
  const baseDelayMs =
    options.baseDelayMs ?? getModelRetryBackoffMs() ?? DEFAULT_MODEL_RETRY_BACKOFF_MS;
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

      const delay = baseDelayMs * attempt;
      await sleep(delay);
    }
  }

  throw new Error(
    `Failed to execute ${options.operation} after ${maxAttempts} attempts.`,
  );
}

interface StreamingRetryOptions<T> extends RequestRetryOptions {
  create: () => Promise<T>;
}

export async function executeStreamingWithRetry<T>(
  options: StreamingRetryOptions<T>,
): Promise<T> {
  const { create, ...requestOptions } = options;
  return executeWithRequestRetry(requestOptions, () => create());
}
