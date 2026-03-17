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

import {
  type ErrorContext,
  type ErrorLogData,
  type ProviderError,
  type StreamDiagnostics,
} from '@shared/schemas';
import { extractErrorMessage, isObject, isString } from '@utils/core';

import { toErrorMessage } from './errorHandlingUtils';

/** Get reason phrase, returning undefined for unknown codes (getReasonPhrase throws). */
function safeGetReasonPhrase(statusCode: number): string | undefined {
  try {
    return getReasonPhrase(statusCode);
  } catch {
    return undefined;
  }
}

type ErrorConstructor<T extends Error = Error> = abstract new (
  ...args: never[]
) => T;

/** SDK error mapping entry. Provider detected from class name. */
interface SdkErrorEntry {
  ctor: ErrorConstructor;
  message?: string;
  fallbackStatusCode?: number;
  retryable?: boolean;
}

function createErrorPair(
  openAiCtor: ErrorConstructor,
  anthropicCtor: ErrorConstructor,
  config: Omit<SdkErrorEntry, 'ctor'>,
): SdkErrorEntry[] {
  return [
    { ctor: openAiCtor, ...config },
    { ctor: anthropicCtor, ...config },
  ];
}

const SDK_ERRORS: SdkErrorEntry[] = [
  // Connection errors (retryable)
  ...createErrorPair(
    OpenAIConnectionTimeoutError,
    AnthropicConnectionTimeoutError,
    { message: 'Connection timed out', retryable: true },
  ),
  ...createErrorPair(OpenAIConnectionError, AnthropicConnectionError, {
    message: 'Connection error',
    retryable: true,
  }),
  // Abort errors (not retryable)
  ...createErrorPair(OpenAIUserAbortError, AnthropicUserAbortError, {
    message: 'Request aborted',
    retryable: false,
  }),
  // HTTP errors (retryable derived from status code)
  ...createErrorPair(OpenAIBadRequestError, AnthropicBadRequestError, {
    fallbackStatusCode: StatusCodes.BAD_REQUEST,
  }),
  ...createErrorPair(OpenAIAuthenticationError, AnthropicAuthenticationError, {
    fallbackStatusCode: StatusCodes.UNAUTHORIZED,
  }),
  ...createErrorPair(
    OpenAIPermissionDeniedError,
    AnthropicPermissionDeniedError,
    { fallbackStatusCode: StatusCodes.FORBIDDEN },
  ),
  ...createErrorPair(OpenAINotFoundError, AnthropicNotFoundError, {
    fallbackStatusCode: StatusCodes.NOT_FOUND,
  }),
  ...createErrorPair(OpenAIConflictError, AnthropicConflictError, {
    fallbackStatusCode: StatusCodes.CONFLICT,
  }),
  ...createErrorPair(
    OpenAIUnprocessableEntityError,
    AnthropicUnprocessableEntityError,
    { fallbackStatusCode: StatusCodes.UNPROCESSABLE_ENTITY },
  ),
  ...createErrorPair(OpenAIRateLimitError, AnthropicRateLimitError, {
    fallbackStatusCode: StatusCodes.TOO_MANY_REQUESTS,
  }),
  ...createErrorPair(OpenAIInternalServerError, AnthropicInternalServerError, {
    fallbackStatusCode: StatusCodes.INTERNAL_SERVER_ERROR,
  }),
  // Generic API errors (no fallback)
  { ctor: OpenAIAPIError },
  { ctor: AnthropicAPIError },
  { ctor: GoogleGenAIApiError },
];

/** All 4xx/5xx are retryable (auto-retries skipped for 401/403 via shouldAutoRetry). */
function isRetryableStatusCode(statusCode?: number): boolean {
  return statusCode !== undefined && statusCode >= 400;
}

/** Partial result before relay detection (isRelayError/rawErrorBody added later). */
type SdkMatchResult = Omit<ProviderError, 'isRelayError' | 'rawErrorBody'>;

/** Match known SDK error types and return structured error details. */
function matchSdkError(
  err: unknown,
  rawErrorBody: unknown,
): SdkMatchResult | undefined {
  const entry = SDK_ERRORS.find(({ ctor }) => err instanceof ctor);
  if (!entry) {
    return undefined;
  }

  const provider = detectProvider(err);
  const requestId = detectRequestId(err);

  // Message-only errors (connection, abort) - use the entry's message
  if (entry.message !== undefined) {
    return {
      message: entry.message,
      provider,
      retryable: entry.retryable ?? false,
      requestId,
    };
  }

  // HTTP errors - detect status code from error object, SDK class, or error body
  const statusCode =
    detectStatusCode(err) ??
    entry.fallbackStatusCode ??
    inferStatusCodeFromBody(rawErrorBody);
  const statusText = detectStatusText(err, statusCode);
  const fallbackMessage = statusCode
    ? safeGetReasonPhrase(statusCode)
    : undefined;
  const finalMessage =
    extractErrorMessage(err) ?? fallbackMessage ?? 'Provider request failed';

  if (!statusCode) {
    // SDK errors without status codes are unusual - be conservative and don't retry
    return {
      message: finalMessage,
      provider,
      retryable: false,
      requestId,
    };
  }

  const prefix = statusText
    ? `HTTP ${statusCode} ${statusText}`
    : `HTTP ${statusCode}`;
  return {
    message: `${prefix} – ${finalMessage}`,
    statusCode,
    statusText,
    provider,
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
  if (isObject(err)) {
    const candidate = err as {
      statusText?: string;
      response?: { statusText?: string };
      error?: { statusText?: string };
    };
    const explicit =
      candidate.statusText ??
      candidate.response?.statusText ??
      candidate.error?.statusText;
    if (explicit) return explicit;
  }
  return statusCode ? safeGetReasonPhrase(statusCode) : undefined;
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

  const lowered = candidate.constructor?.name?.toLowerCase();
  if (!lowered) return undefined;

  return (['openai', 'anthropic', 'google', 'kimi'] as const).find((p) =>
    lowered.includes(p),
  );
}

/** Extract request ID from SDK errors (property or headers). */
function detectRequestId(err: unknown): string | undefined {
  if (!isObject(err)) return undefined;

  const candidate = err as {
    request_id?: string;
    requestId?: string;
    headers?: { get?: (key: string) => string | null };
  };

  const directId = candidate.request_id ?? candidate.requestId;
  if (isString(directId) && directId) {
    return directId;
  }

  // Try headers (Anthropic SDK uses 'request-id'; relay may use 'x-request-id')
  // ?? undefined converts null from headers.get() to undefined
  return (
    candidate.headers?.get?.('request-id') ??
    candidate.headers?.get?.('x-request-id') ??
    undefined
  );
}

/** Extract raw error body from SDK errors for relay error debugging. */
function detectRawErrorBody(err: unknown): unknown {
  if (!isObject(err)) {
    return undefined;
  }

  const candidate = err as {
    error?: unknown;
    body?: unknown;
    data?: unknown;
    response?: { data?: unknown };
    message?: string;
  };

  const directBody =
    candidate.error ??
    candidate.body ??
    candidate.data ??
    candidate.response?.data;
  if (directBody !== undefined) {
    return directBody;
  }

  // Google GenAI SDK may embed JSON in the error message
  if (candidate.message && candidate.message.startsWith('{')) {
    try {
      return JSON.parse(candidate.message);
    } catch {
      // Not valid JSON, ignore
    }
  }

  return undefined;
}

const STREAM_DIAGNOSTICS_KEY = Symbol.for('texra.streamDiagnostics');

/** Attaches stream diagnostics to an error before rethrowing. */
export function attachStreamDiagnostics(
  err: unknown,
  diagnostics: StreamDiagnostics,
): void {
  if (isObject(err)) {
    (err as Record<symbol, unknown>)[STREAM_DIAGNOSTICS_KEY] = diagnostics;
  }
}

function detectStreamDiagnostics(err: unknown): StreamDiagnostics | undefined {
  if (!isObject(err)) {
    return undefined;
  }
  const diagnostics = (err as Record<symbol, unknown>)[STREAM_DIAGNOSTICS_KEY];
  // Basic type check - diagnostics should be an object with expected fields
  if (isObject(diagnostics) && 'eventsProcessed' in diagnostics) {
    return diagnostics as StreamDiagnostics;
  }
  return undefined;
}

/**
 * Maps Anthropic error type strings to their corresponding HTTP status codes.
 * Used to recover the status code when SDK error objects lose it
 * (e.g., streaming SSE errors that produce generic APIError instances).
 */
const ANTHROPIC_ERROR_TYPE_TO_STATUS: Record<string, number> = {
  invalid_request_error: StatusCodes.BAD_REQUEST, // 400
  authentication_error: StatusCodes.UNAUTHORIZED, // 401
  permission_error: StatusCodes.FORBIDDEN, // 403
  not_found_error: StatusCodes.NOT_FOUND, // 404
  request_too_large: StatusCodes.REQUEST_TOO_LONG, // 413
  rate_limit_error: StatusCodes.TOO_MANY_REQUESTS, // 429
  api_error: StatusCodes.INTERNAL_SERVER_ERROR, // 500
  timeout_error: StatusCodes.REQUEST_TIMEOUT, // 408
  overloaded_error: 529,
};

/**
 * Infers an HTTP status code from the Anthropic error type in the raw error body.
 * Handles both `{ type: "api_error" }` and `{ error: { type: "api_error" } }`.
 */
function inferStatusCodeFromBody(rawErrorBody: unknown): number | undefined {
  if (!isObject(rawErrorBody)) {
    return undefined;
  }
  const body = rawErrorBody as { type?: unknown; error?: { type?: unknown } };
  const errorType =
    (isString(body.type) ? body.type : undefined) ??
    (isObject(body.error) && isString(body.error.type)
      ? body.error.type
      : undefined);
  return errorType ? ANTHROPIC_ERROR_TYPE_TO_STATUS[errorType] : undefined;
}

function isRelayError(rawErrorBody: unknown): boolean {
  if (!isObject(rawErrorBody)) {
    return false;
  }
  // Direct check (OpenAI/Anthropic SDKs extract the error object)
  if ('_relay' in rawErrorBody) {
    return true;
  }
  // Nested check (Google GenAI may preserve full response body)
  const nested = (rawErrorBody as { error?: unknown }).error;
  return isObject(nested) && '_relay' in nested;
}

function determineRetryable(statusCode?: number, rawErrorBody?: unknown): boolean {
  if (isRelayError(rawErrorBody)) {
    return true;
  }
  return isRetryableStatusCode(statusCode);
}

export function formatProviderHttpError(err: unknown): ProviderError {
  const rawErrorBody = detectRawErrorBody(err);
  const streamDiagnostics = detectStreamDiagnostics(err);

  // Handle DOMException AbortError (from AbortController.abort())
  if (err instanceof DOMException && err.name === 'AbortError') {
    return {
      message: 'Request aborted',
      retryable: false,
      isRelayError: false,
      rawErrorBody,
      streamDiagnostics,
    };
  }

  const sdkMatch = matchSdkError(err, rawErrorBody);
  if (sdkMatch) {
    const isRelay = isRelayError(rawErrorBody);
    const retryable =
      determineRetryable(sdkMatch.statusCode, rawErrorBody) ||
      sdkMatch.retryable;
    return {
      ...sdkMatch,
      retryable,
      isRelayError: isRelay,
      rawErrorBody,
      streamDiagnostics,
    };
  }

  // Fallback for unrecognized errors
  const statusCode = detectStatusCode(err);
  const statusText = detectStatusText(err, statusCode);
  const provider = detectProvider(err);
  const requestId = detectRequestId(err);
  const isRelay = isRelayError(rawErrorBody);

  const fallbackMessage = statusCode
    ? safeGetReasonPhrase(statusCode)
    : undefined;
  const finalMessage =
    extractErrorMessage(err) ?? fallbackMessage ?? 'Provider request failed';

  if (!statusCode) {
    // Unrecognized errors without status codes are likely network errors - retry
    return {
      message: finalMessage,
      provider,
      retryable: true,
      isRelayError: isRelay,
      requestId,
      rawErrorBody,
      streamDiagnostics,
    };
  }

  const prefix = statusText
    ? `HTTP ${statusCode} ${statusText}`
    : `HTTP ${statusCode}`;
  return {
    message: `${prefix} – ${finalMessage}`,
    statusCode,
    statusText,
    provider,
    retryable: determineRetryable(statusCode, rawErrorBody),
    isRelayError: isRelay,
    requestId,
    rawErrorBody,
    streamDiagnostics,
  };
}

export function getSdkErrorMessage(err: unknown): string {
  return formatProviderHttpError(err).message;
}

const CONTEXT_WINDOW_PATTERNS = [
  'exceeds context window', // TeXRA internal, Anthropic
  'exceeds the context window', // OpenAI Responses API
  'context length exceeded', // Google
  'maximum context length', // OpenAI
  'token limit exceeded', // Anthropic
  'too many tokens', // OpenAI
  'input too long', // Google
] as const;

/** Checks if an error is a context window violation (should not be retried). */
export function isContextWindowError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const message = err.message.toLowerCase();
  return CONTEXT_WINDOW_PATTERNS.some((pattern) => message.includes(pattern));
}

/** Checks for OpenAI SDK "missing finish_reason" error (DeepSeek, other providers). */
export function isMissingFinishReasonError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  return err.message.includes('missing finish_reason');
}

/** Checks if an error indicates the previous_response_id is invalid (OpenAI Responses API). */
export function isPreviousResponseIdError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('previous_response_id');
}

/** Builds consistent error data for logging with MESSAGE_TYPES.ERROR. */
export function buildErrorLogData(
  err: unknown,
  context?: ErrorContext,
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
