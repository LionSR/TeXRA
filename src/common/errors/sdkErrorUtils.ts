// Third-party imports
import { getReasonPhrase, StatusCodes } from 'http-status-codes';
import {
  APIConnectionError as AnthropicConnectionError,
  APIConnectionTimeoutError as AnthropicConnectionTimeoutError,
  APIError as AnthropicAPIError,
  APIUserAbortError as AnthropicUserAbortError,
  AuthenticationError as AnthropicAuthenticationError,
  BadRequestError as AnthropicBadRequestError,
  ConflictError as AnthropicConflictError,
  InternalServerError as AnthropicInternalServerError,
  NotFoundError as AnthropicNotFoundError,
  PermissionDeniedError as AnthropicPermissionDeniedError,
  RateLimitError as AnthropicRateLimitError,
  UnprocessableEntityError as AnthropicUnprocessableEntityError,
} from '@anthropic-ai/sdk';
import { ApiError as GoogleGenAIApiError } from '@google/genai';
import {
  APIConnectionError as OpenAIConnectionError,
  APIConnectionTimeoutError as OpenAIConnectionTimeoutError,
  APIError as OpenAIAPIError,
  APIUserAbortError as OpenAIUserAbortError,
  AuthenticationError as OpenAIAuthenticationError,
  BadRequestError as OpenAIBadRequestError,
  ConflictError as OpenAIConflictError,
  InternalServerError as OpenAIInternalServerError,
  NotFoundError as OpenAINotFoundError,
  PermissionDeniedError as OpenAIPermissionDeniedError,
  RateLimitError as OpenAIRateLimitError,
  UnprocessableEntityError as OpenAIUnprocessableEntityError,
} from 'openai';

// Local imports - core utilities
import { extractErrorMessage, isObject, isString } from '@utils/core';
import { toErrorMessage } from './errorHandlingUtils';

/**
 * Structured representation of a provider HTTP failure.
 */
export interface ProviderHttpErrorDetails {
  /**
   * Human readable description of the provider failure. Includes HTTP prefix when
   * a status code is available.
   */
  message: string;
  /** HTTP status code reported by the provider, when present. */
  statusCode?: number;
  /** HTTP status text reported by the provider or derived from the status code. */
  statusText?: string;
  /** Identifier for the provider that produced the error, when known. */
  provider?: string;
  /**
   * Whether the error is retryable. Based on native SDK error types:
   * - Connection errors (timeout, network) → retryable
   * - Server errors (5xx) and rate limits (429) → retryable
   * - User abort, auth errors, bad requests → NOT retryable
   */
  retryable: boolean;
  /** Request ID from the provider, useful for debugging with support. */
  requestId?: string;
}

/**
 * Safely get the reason phrase for a status code.
 * Returns undefined if the status code is not recognized.
 */
function safeGetReasonPhrase(statusCode: number): string | undefined {
  try {
    return getReasonPhrase(statusCode);
  } catch (_err) {
    return undefined;
  }
}

type ErrorConstructor<T extends Error = Error> = abstract new (
  ...args: never[]
) => T;

interface NativeMessageErrorEntry {
  ctor: ErrorConstructor;
  provider: string;
  message?: string;
  /** Whether this error type is retryable (e.g., connection errors are, user aborts are not) */
  retryable: boolean;
}

interface NativeHttpErrorEntry {
  ctor: ErrorConstructor;
  provider: string;
  fallbackStatusCode?: number;
}

const NATIVE_MESSAGE_ERRORS: NativeMessageErrorEntry[] = [
  {
    ctor: OpenAIConnectionTimeoutError,
    provider: 'openai',
    message: 'Connection timed out',
    retryable: true,
  },
  {
    ctor: AnthropicConnectionTimeoutError,
    provider: 'anthropic',
    message: 'Connection timed out',
    retryable: true,
  },
  {
    ctor: OpenAIConnectionError,
    provider: 'openai',
    message: 'Connection error',
    retryable: true,
  },
  {
    ctor: AnthropicConnectionError,
    provider: 'anthropic',
    message: 'Connection error',
    retryable: true,
  },
  {
    ctor: OpenAIUserAbortError,
    provider: 'openai',
    message: 'Request aborted',
    retryable: false,
  },
  {
    ctor: AnthropicUserAbortError,
    provider: 'anthropic',
    message: 'Request aborted',
    retryable: false,
  },
];

const NATIVE_HTTP_ERRORS: NativeHttpErrorEntry[] = [
  {
    ctor: OpenAIBadRequestError,
    provider: 'openai',
    fallbackStatusCode: StatusCodes.BAD_REQUEST,
  },
  {
    ctor: AnthropicBadRequestError,
    provider: 'anthropic',
    fallbackStatusCode: StatusCodes.BAD_REQUEST,
  },
  {
    ctor: OpenAIAuthenticationError,
    provider: 'openai',
    fallbackStatusCode: StatusCodes.UNAUTHORIZED,
  },
  {
    ctor: AnthropicAuthenticationError,
    provider: 'anthropic',
    fallbackStatusCode: StatusCodes.UNAUTHORIZED,
  },
  {
    ctor: OpenAIPermissionDeniedError,
    provider: 'openai',
    fallbackStatusCode: StatusCodes.FORBIDDEN,
  },
  {
    ctor: AnthropicPermissionDeniedError,
    provider: 'anthropic',
    fallbackStatusCode: StatusCodes.FORBIDDEN,
  },
  {
    ctor: OpenAINotFoundError,
    provider: 'openai',
    fallbackStatusCode: StatusCodes.NOT_FOUND,
  },
  {
    ctor: AnthropicNotFoundError,
    provider: 'anthropic',
    fallbackStatusCode: StatusCodes.NOT_FOUND,
  },
  {
    ctor: OpenAIConflictError,
    provider: 'openai',
    fallbackStatusCode: StatusCodes.CONFLICT,
  },
  {
    ctor: AnthropicConflictError,
    provider: 'anthropic',
    fallbackStatusCode: StatusCodes.CONFLICT,
  },
  {
    ctor: OpenAIUnprocessableEntityError,
    provider: 'openai',
    fallbackStatusCode: StatusCodes.UNPROCESSABLE_ENTITY,
  },
  {
    ctor: AnthropicUnprocessableEntityError,
    provider: 'anthropic',
    fallbackStatusCode: StatusCodes.UNPROCESSABLE_ENTITY,
  },
  {
    ctor: OpenAIRateLimitError,
    provider: 'openai',
    fallbackStatusCode: StatusCodes.TOO_MANY_REQUESTS,
  },
  {
    ctor: AnthropicRateLimitError,
    provider: 'anthropic',
    fallbackStatusCode: StatusCodes.TOO_MANY_REQUESTS,
  },
  {
    ctor: OpenAIInternalServerError,
    provider: 'openai',
    fallbackStatusCode: StatusCodes.INTERNAL_SERVER_ERROR,
  },
  {
    ctor: AnthropicInternalServerError,
    provider: 'anthropic',
    fallbackStatusCode: StatusCodes.INTERNAL_SERVER_ERROR,
  },
  { ctor: OpenAIAPIError, provider: 'openai' },
  { ctor: AnthropicAPIError, provider: 'anthropic' },
  { ctor: GoogleGenAIApiError, provider: 'google' },
];

function matchNativeMessageError(
  err: unknown,
): ProviderHttpErrorDetails | undefined {
  const entry = NATIVE_MESSAGE_ERRORS.find(({ ctor }) => err instanceof ctor);
  if (!entry) {
    return undefined;
  }

  return {
    message:
      entry.message ?? extractErrorMessage(err) ?? 'Provider request failed',
    provider: entry.provider,
    retryable: entry.retryable,
  };
}

/** Status codes that are retryable (5xx server errors, rate limits, timeouts) */
const RETRYABLE_STATUS_CODES = new Set([
  StatusCodes.REQUEST_TIMEOUT,
  StatusCodes.TOO_MANY_REQUESTS,
  StatusCodes.INTERNAL_SERVER_ERROR,
  StatusCodes.BAD_GATEWAY,
  StatusCodes.SERVICE_UNAVAILABLE,
  StatusCodes.GATEWAY_TIMEOUT,
]);

function isRetryableStatusCode(statusCode?: number): boolean {
  if (statusCode === undefined) {
    return false;
  }
  // All 5xx errors are retryable
  if (statusCode >= StatusCodes.INTERNAL_SERVER_ERROR) {
    return true;
  }
  return RETRYABLE_STATUS_CODES.has(statusCode);
}

function matchNativeHttpError(
  err: unknown,
): ProviderHttpErrorDetails | undefined {
  const entry = NATIVE_HTTP_ERRORS.find(({ ctor }) => err instanceof ctor);
  if (!entry) {
    return undefined;
  }

  const statusCode = detectStatusCode(err) ?? entry.fallbackStatusCode;
  const statusText = detectStatusText(err, statusCode);
  const requestId = detectRequestId(err);
  const fallbackMessage = statusCode
    ? safeGetReasonPhrase(statusCode)
    : undefined;
  const finalMessage =
    extractErrorMessage(err) ?? fallbackMessage ?? 'Provider request failed';

  if (!statusCode) {
    // Known SDK error types without status codes are unusual (SDK errors typically
    // have status codes). Be conservative and don't retry.
    // Note: This differs from formatProviderHttpError's fallback which treats
    // unrecognized errors without status codes as retryable (likely network errors).
    return {
      message: finalMessage,
      provider: entry.provider,
      retryable: false,
      requestId,
    };
  }

  const prefix = `HTTP ${statusCode}${statusText ? ` ${statusText}` : ''}`;
  return {
    message: `${prefix} – ${finalMessage}`,
    statusCode,
    statusText,
    provider: entry.provider,
    retryable: isRetryableStatusCode(statusCode),
    requestId,
  };
}

type StatusCarrier = {
  status?: number;
  statusCode?: number;
  code?: number;
  response?: { status?: number };
  error?: { status?: number };
};

function pickStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function detectStatusCode(err: unknown): number | undefined {
  if (!isObject(err)) {
    return undefined;
  }

  const candidate = err as StatusCarrier;
  return (
    pickStatus(candidate.status) ??
    pickStatus(candidate.statusCode) ??
    pickStatus(candidate.code) ??
    pickStatus(candidate.response?.status) ??
    pickStatus(candidate.error?.status)
  );
}

function detectStatusText(
  err: unknown,
  statusCode?: number,
): string | undefined {
  if (!isObject(err)) {
    return statusCode ? safeGetReasonPhrase(statusCode) : undefined;
  }

  const candidate = err as {
    statusText?: string;
    response?: { statusText?: string };
    error?: { statusText?: string };
  };

  return (
    candidate.statusText ??
    candidate.response?.statusText ??
    candidate.error?.statusText ??
    (statusCode ? safeGetReasonPhrase(statusCode) : undefined)
  );
}

function detectProvider(err: unknown): string | undefined {
  if (!isObject(err)) {
    return undefined;
  }

  const candidate = err as { provider?: string } & {
    constructor?: { name?: string };
  };

  if (isString(candidate.provider)) {
    return candidate.provider;
  }

  const name = candidate.constructor?.name;
  if (!name) {
    return undefined;
  }

  const lowered = name.toLowerCase();
  if (lowered.includes('openai')) {
    return 'openai';
  }
  if (lowered.includes('anthropic')) {
    return 'anthropic';
  }
  if (lowered.includes('google')) {
    return 'google';
  }
  if (lowered.includes('kimi')) {
    return 'kimi';
  }

  return undefined;
}

/**
 * Extracts request ID from SDK errors for debugging with provider support.
 * OpenAI uses 'request_id', Anthropic uses 'request_id' in headers.
 */
function detectRequestId(err: unknown): string | undefined {
  if (!isObject(err)) {
    return undefined;
  }

  const candidate = err as {
    request_id?: string;
    requestId?: string;
    headers?: { get?: (key: string) => string | null };
  };

  // OpenAI SDK: request_id property
  if (isString(candidate.request_id) && candidate.request_id) {
    return candidate.request_id;
  }

  // Alternative casing
  if (isString(candidate.requestId) && candidate.requestId) {
    return candidate.requestId;
  }

  // Try headers (x-request-id is common)
  if (candidate.headers?.get) {
    const headerRequestId = candidate.headers.get('x-request-id');
    if (headerRequestId) {
      return headerRequestId;
    }
  }

  return undefined;
}

/**
 * Formats SDK errors from model providers into a consistent message so agent logs
 * can surface status codes alongside concise descriptions.
 *
 * The helper prefers the native SDK error classes for OpenAI, Anthropic, and
 * Google responses. When the error is not a known class, it inspects common
 * HTTP-shaped fields and falls back to a best-effort summary.
 *
 * Note: Abort/cancellation detection is handled at the flow level by checking
 * the AbortController signal directly (this.signal?.aborted). Native SDK abort
 * errors (OpenAI/Anthropic APIUserAbortError) are detected by matchNativeMessageError().
 */
export function formatProviderHttpError(
  err: unknown,
): ProviderHttpErrorDetails {
  const nativeMessage = matchNativeMessageError(err);
  if (nativeMessage) {
    // Add requestId even for message-only errors
    const requestId = detectRequestId(err);
    return requestId ? { ...nativeMessage, requestId } : nativeMessage;
  }

  const nativeHttp = matchNativeHttpError(err);
  if (nativeHttp) {
    return nativeHttp;
  }

  const statusCode = detectStatusCode(err);
  const statusText = detectStatusText(err, statusCode);
  const provider = detectProvider(err);
  const requestId = detectRequestId(err);

  const fallbackMessage = statusCode
    ? safeGetReasonPhrase(statusCode)
    : undefined;
  const finalMessage =
    extractErrorMessage(err) ?? fallbackMessage ?? 'Provider request failed';

  if (!statusCode) {
    // Unrecognized errors without status codes reached the fallback path.
    // These are likely network/connection errors (not SDK-typed) and should
    // be retryable. Note: This differs from matchNativeHttpError which is
    // conservative for known SDK types missing status codes.
    return {
      message: finalMessage,
      provider,
      retryable: true,
      requestId,
    };
  }

  const prefix = `HTTP ${statusCode}${statusText ? ` ${statusText}` : ''}`;
  return {
    message: `${prefix} – ${finalMessage}`,
    statusCode,
    statusText,
    provider,
    retryable: isRetryableStatusCode(statusCode),
    requestId,
  };
}

export function getSdkErrorMessage(err: unknown): string {
  return formatProviderHttpError(err).message;
}

// ============================================================================
// Context Window Error Detection
// ============================================================================

/**
 * Patterns that indicate a context window/token limit violation.
 * These are intentional validation errors that should NOT be retried
 * and should propagate to fail fast.
 *
 * Pattern coverage by provider:
 * - TeXRA internal: "exceeds context window" (token counting validation)
 * - OpenAI: "maximum context length", "too many tokens"
 * - Anthropic: "exceeds context window", "token limit exceeded"
 * - Google: "input too long", "context length exceeded"
 */
const CONTEXT_WINDOW_PATTERNS = [
  'exceeds context window', // TeXRA internal, Anthropic
  'context length exceeded', // Google
  'maximum context length', // OpenAI
  'token limit exceeded', // Anthropic
  'too many tokens', // OpenAI
  'input too long', // Google
] as const;

/**
 * Checks if an error is a context window violation.
 * These errors should NOT be caught by soft failure handlers because
 * they indicate the input needs to be reduced - retrying won't help.
 *
 * Use this to re-throw context window errors in token counting catch blocks:
 * @example
 * ```ts
 * try {
 *   await countTokens(input);
 * } catch (err) {
 *   if (isContextWindowError(err)) {
 *     throw err; // Don't swallow - this is intentional validation
 *   }
 *   logger.warn('Token counting failed, proceeding without adjustment');
 * }
 * ```
 */
export function isContextWindowError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const message = err.message.toLowerCase();
  return CONTEXT_WINDOW_PATTERNS.some((pattern) => message.includes(pattern));
}

/**
 * Checks if an error is the OpenAI SDK "missing finish_reason" error.
 * This error occurs when the streaming response doesn't include a finish_reason
 * in the final chunk, which can happen with:
 * - DeepSeek reasoning models
 * - Other OpenAI-compatible APIs that don't properly send finish_reason
 *
 * When detected, the streaming aggregator should be used to build a fallback
 * response with a default finish_reason of 'stop'.
 *
 * @see https://github.com/openai/openai-node/issues/499
 * @see https://github.com/openai/openai-node/issues/1206
 */
export function isMissingFinishReasonError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  return err.message.includes('missing finish_reason');
}

/**
 * Context for building error log data.
 */
export interface ErrorLogContext {
  /** The operation that failed (e.g., 'API request', 'manual retry'). */
  operation?: string;
  /** The model being used when the error occurred. */
  model?: string;
}

// ============================================================================
// Error Enrichment
// ============================================================================

/**
 * WeakMap to store operation context on error objects without modifying them.
 * This allows us to track where errors originated as they propagate up the stack.
 */
const errorContextMap = new WeakMap<object, ErrorLogContext>();

/**
 * Enriches an error with operation context without logging.
 * The context is stored in a WeakMap and can be extracted later when the error
 * is finally logged at the boundary (e.g., in Node's retryPrompt or execFallback).
 *
 * This follows the "log at the boundary" principle:
 * - Middle layers enrich errors with context
 * - Only the final handler logs, with full context
 *
 * @param error - The error to enrich
 * @param context - Operation context (operation name, model)
 * @returns The same error (for throw chaining)
 */
export function enrichError<T>(error: T, context: ErrorLogContext): T {
  if (error && typeof error === 'object') {
    // Merge with any existing context (inner operations are preserved)
    const existing = errorContextMap.get(error) ?? {};
    errorContextMap.set(error, {
      ...context,
      // Keep the innermost operation if already set (more specific)
      operation: existing.operation ?? context.operation,
      // Keep the model if already set
      model: existing.model ?? context.model,
    });
  }
  return error;
}

/**
 * Structured data for error log messages.
 * Used by progressView formatters to display error details.
 */
export interface ErrorLogData extends ProviderHttpErrorDetails {
  /** Raw error message before formatting. */
  rawMessage?: string;
  /** The operation that failed. */
  operation?: string;
  /** The model being used. */
  model?: string;
}

/**
 * Builds consistent error data for logging with MESSAGE_TYPES.ERROR.
 * Ensures all error logs have the same structure for DRY display formatting.
 */
export function buildErrorLogData(
  err: unknown,
  context?: ErrorLogContext,
): ErrorLogData {
  const formatted = formatProviderHttpError(err);
  const rawMessage = toErrorMessage(err);

  return {
    ...formatted,
    rawMessage: rawMessage !== formatted.message ? rawMessage : undefined,
    operation: context?.operation,
    model: context?.model,
  };
}
