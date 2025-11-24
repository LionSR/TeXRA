// Local imports - logging
import {
  formatProviderHttpError,
  getSdkErrorMessage,
} from '@common/errors/sdkErrorUtils';
import type { AgentLogger } from '@logger/AgentLogger';
import { MESSAGE_TYPES } from '@logger/messageTypes';
import { sleep } from '@utils/helpers';

interface RequestRetryOptions {
  logger: AgentLogger;
  operation: string;
  model?: string;
  signal?: AbortSignal;
  maxAttempts?: number;
  baseDelayMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 1000;
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

function shouldRetry(statusCode?: number): boolean {
  if (statusCode === undefined) {
    return false;
  }
  if (statusCode >= 500) {
    return true;
  }
  return RETRYABLE_STATUS_CODES.has(statusCode);
}

export async function executeWithRequestRetry<T>(
  options: RequestRetryOptions,
  request: () => Promise<T> | T,
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BACKOFF_MS;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new Error('The request was aborted.');
    }

    try {
      return await Promise.resolve(request());
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
  create: () => Promise<{ result: T; cleanup?: () => void }>;
}

export async function executeStreamingWithRetry<T>(
  options: StreamingRetryOptions<T>,
): Promise<T> {
  const { create, ...requestOptions } = options;
  return executeWithRequestRetry(requestOptions, async () => {
    const { result, cleanup } = await create();
    cleanup?.();
    return result;
  });
}
