import { getReasonPhrase, StatusCodes } from 'http-status-codes';
import {
  type ErrorContext,
  type ErrorLogData,
  type ProviderError,
  type StreamDiagnostics,
} from '@shared/schemas';
import { extractErrorMessage, isObject, isString } from '@utils/core';

import { toErrorMessage } from './errorMessage';
import { isDiskFullError } from './errorPredicates';

/** Get reason phrase, returning undefined for unknown codes (getReasonPhrase throws). */
function safeGetReasonPhrase(statusCode: number): string | undefined {
  try {
    return getReasonPhrase(statusCode);
  } catch {
    return undefined;
  }
}

/** SDK error mapping entry. Provider detected from class name. */
interface SdkErrorEntry {
  classNames: readonly string[];
  message?: string;
  fallbackStatusCode?: number;
  retryable?: boolean;
}

const SDK_ERRORS: SdkErrorEntry[] = [
  // Connection errors (retryable)
  {
    classNames: ['APIConnectionTimeoutError'],
    message: 'Connection timed out',
    retryable: true,
  },
  {
    classNames: ['APIConnectionError'],
    message: 'Connection error',
    retryable: true,
  },
  // Abort errors (not retryable)
  {
    classNames: ['APIUserAbortError'],
    message: 'Request aborted',
    retryable: false,
  },
  // HTTP errors (retryable derived from status code)
  {
    classNames: ['BadRequestError'],
    fallbackStatusCode: StatusCodes.BAD_REQUEST,
  },
  {
    classNames: ['AuthenticationError'],
    fallbackStatusCode: StatusCodes.UNAUTHORIZED,
  },
  {
    classNames: ['PermissionDeniedError'],
    fallbackStatusCode: StatusCodes.FORBIDDEN,
  },
  {
    classNames: ['NotFoundError'],
    fallbackStatusCode: StatusCodes.NOT_FOUND,
  },
  {
    classNames: ['ConflictError'],
    fallbackStatusCode: StatusCodes.CONFLICT,
  },
  {
    classNames: ['UnprocessableEntityError'],
    fallbackStatusCode: StatusCodes.UNPROCESSABLE_ENTITY,
  },
  {
    classNames: ['RateLimitError'],
    fallbackStatusCode: StatusCodes.TOO_MANY_REQUESTS,
  },
  {
    classNames: ['InternalServerError'],
    fallbackStatusCode: StatusCodes.INTERNAL_SERVER_ERROR,
  },
  // Generic API errors (no fallback)
  { classNames: ['APIError', 'ApiError'] },
];

/** Server errors (5xx), rate limits (429), and request timeouts (408) are retryable
 *  — these are transient. Other client errors (4xx) are deterministic. */
export function isRetryableStatusCode(statusCode?: number): boolean {
  if (statusCode === undefined) return false;
  if (statusCode >= 500) return true;
  return (
    statusCode === StatusCodes.TOO_MANY_REQUESTS ||
    statusCode === StatusCodes.REQUEST_TIMEOUT
  );
}

/** Partial result before relay detection (isRelayError/rawErrorBody added later). */
type SdkMatchResult = Omit<ProviderError, 'isRelayError' | 'rawErrorBody'>;

/** Match known SDK error types and return structured error details. */
function matchSdkError(
  err: unknown,
  rawErrorBody: unknown,
): SdkMatchResult | undefined {
  const errorClassNames = getErrorClassNames(err);
  const entry = SDK_ERRORS.find(({ classNames }) =>
    classNames.some((className) => errorClassNames.includes(className)),
  );
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

  // HTTP errors - detect status code from error object, SDK class, or error body.
  // If detectStatusCode returns a non-error code (< 400), it's likely misleading
  // (e.g., SSE connection status 200 while the actual error is in the body),
  // so prefer the body-inferred status code in that case.
  const rawStatusCode = detectStatusCode(err);
  const statusCode =
    (rawStatusCode !== undefined && rawStatusCode >= 400
      ? rawStatusCode
      : undefined) ??
    entry.fallbackStatusCode ??
    inferStatusCodeFromBody(rawErrorBody) ??
    rawStatusCode;
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

function getErrorClassNames(err: unknown): string[] {
  if (!isObject(err)) return [];

  const classNames = new Set<string>();
  let prototype = Object.getPrototypeOf(err);
  while (prototype && prototype !== Object.prototype) {
    const className = prototype.constructor?.name;
    if (isString(className) && className.length > 0) {
      classNames.add(className);
    }
    prototype = Object.getPrototypeOf(prototype);
  }
  return [...classNames];
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

  const candidate = err as { provider?: string; headers?: HeaderBag } & {
    stack?: string;
  };

  if (isString(candidate.provider)) {
    return candidate.provider;
  }

  const classNameProvider = detectProviderFromClassNames(getErrorClassNames(err));
  if (classNameProvider) return classNameProvider;

  const providerFromStack = detectProviderFromText(candidate.stack ?? '');
  if (providerFromStack) {
    return providerFromStack;
  }

  return detectProviderFromHeaders(candidate.headers);
}

function detectProviderFromClassNames(
  classNames: readonly (string | undefined)[],
): string | undefined {
  // Match SDK class-name fragments, then normalize aliases to the canonical
  // API-provider names used by SecretManager / model handlers. This also covers
  // no-response connection errors whose provider only appears on a base SDK
  // class such as OpenAIError or AnthropicError.
  const names = classNames
    .filter((name): name is string => isString(name) && name.length > 0)
    .map((name) => name.toLowerCase());
  const match = (['openai', 'anthropic', 'google', 'kimi'] as const).find(
    (provider) => names.some((name) => name.includes(provider)),
  );
  if (match === 'kimi') return 'moonshot';
  return match;
}

type HeaderBag =
  | {
      get?: (key: string) => string | null;
    }
  | Record<string, unknown>;
type HeaderDetectedProvider = 'anthropic';

function getHeaderValue(
  headers: HeaderBag | undefined,
  name: string,
): string | undefined {
  const maybeGet = isObject(headers) ? headers.get : undefined;
  const direct =
    typeof maybeGet === 'function' ? maybeGet.call(headers, name) : undefined;
  if (isString(direct) && direct) return direct;

  const indexed = (headers as Record<string, unknown> | undefined)?.[name];
  return isString(indexed) && indexed ? indexed : undefined;
}

function detectProviderFromHeaders(
  headers: HeaderBag | undefined,
): HeaderDetectedProvider | undefined {
  if (getHeaderValue(headers, 'request-id')) return 'anthropic';
  return undefined;
}

function detectProviderFromText(text: string): string | undefined {
  const lowered = text.toLowerCase().replaceAll('\\', '/');
  if (lowered.includes(`@anthropic-${'ai'}/sdk`)) return 'anthropic';
  if (lowered.includes('node_modules/openai')) return 'openai';
  // Keep the Google package marker split so the desktop startup bundle
  // verifier does not mistake this stack-text detector for an eager SDK import.
  if (lowered.includes(`@google/${'genai'}`)) return 'google';
  return undefined;
}

/** Extract request ID from SDK errors (property or headers). */
function detectRequestId(err: unknown): string | undefined {
  if (!isObject(err)) return undefined;

  const candidate = err as {
    request_id?: string;
    requestId?: string;
    requestID?: string;
    headers?: HeaderBag;
  };

  const directId =
    candidate.request_id ?? candidate.requestId ?? candidate.requestID;
  if (isString(directId) && directId) {
    return directId;
  }

  // Try headers (Anthropic SDK uses 'request-id'; relay may use 'x-request-id')
  // ?? undefined converts null from headers.get() to undefined
  return (
    getHeaderValue(candidate.headers, 'request-id') ??
    getHeaderValue(candidate.headers, 'x-request-id') ??
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

/** Max tail size (chars) for partial text attached to streaming errors.
 *  4KB is enough for a "continue from [tail]" prompt and UI display,
 *  while staying well under webview message-size limits. */
export const PARTIAL_TEXT_TAIL_MAX = 4096;

/** Returns the last `maxChars` of `text`. If `text` is shorter, returns it
 *  as-is. Used by streaming handlers to cap partial output on error. */
export function takeTail(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(text.length - maxChars);
}

/** True if `err` is an SDK user-abort error by prototype class name. */
export function isUserAbort(err: unknown): boolean {
  return getErrorClassNames(err).includes('APIUserAbortError');
}

/** Factory for symbol-keyed error metadata. Creates matched attach/detect
 *  accessors that share a single Symbol.for key. The optional typeGuard
 *  validates the value on retrieval; without it, raw retrieval is returned. */
function createErrorMetadata<T>(
  name: string,
  typeGuard?: (v: unknown) => v is T,
): {
  attach: (err: unknown, value: T) => void;
  detect: (err: unknown) => T | undefined;
} {
  const key = Symbol.for(`texra.${name}`);
  return {
    attach: (err, value) => {
      if (isObject(err)) {
        (err as Record<symbol, unknown>)[key] = value;
      }
    },
    detect: (err) => {
      if (!isObject(err)) return undefined;
      const value = (err as Record<symbol, unknown>)[key];
      if (typeGuard) {
        return typeGuard(value) ? value : undefined;
      }
      return value as T | undefined;
    },
  };
}

const streamDiagnosticsMetadata = createErrorMetadata<StreamDiagnostics>(
  'streamDiagnostics',
  (v): v is StreamDiagnostics => isObject(v) && 'eventsProcessed' in v,
);

/** Attaches stream diagnostics to an error before rethrowing. */
export const attachStreamDiagnostics = streamDiagnosticsMetadata.attach;
const detectStreamDiagnostics = streamDiagnosticsMetadata.detect;

const partialTextMetadata = createErrorMetadata<string>(
  'partialText',
  (v): v is string => isString(v) && v.length > 0,
);

/** Attaches partial text (generated before a stream failure) to an error.
 *  Lets the caller surface the partial content to the user or use it as the
 *  basis for a continuation prompt on retry. No-op if the text is empty. */
export function attachPartialText(err: unknown, text: string): void {
  if (text) partialTextMetadata.attach(err, text);
}

const detectPartialText = partialTextMetadata.detect;

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
 * Handles both the envelope format `{ type: "error", error: { type: "api_error" } }`
 * and the direct format `{ type: "api_error" }`.
 *
 * The nested path is checked first because Anthropic's canonical envelope uses
 * `type: "error"` at the top level (not a real error type), with the actual
 * error classification in `error.type`.
 */
function inferStatusCodeFromBody(rawErrorBody: unknown): number | undefined {
  if (!isObject(rawErrorBody)) {
    return undefined;
  }
  const body = rawErrorBody as { type?: unknown; error?: { type?: unknown } };
  // Nested first: { type: "error", error: { type: "api_error" } }
  const nestedType =
    isObject(body.error) && isString(body.error.type)
      ? body.error.type
      : undefined;
  // Direct fallback: { type: "api_error" }
  const directType = isString(body.type) ? body.type : undefined;
  const errorType = nestedType ?? directType;
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

/** True when the relay rejected the request due to the user's monthly
 *  spending limit being reached (supabase/functions/relay marks this with
 *  `limitReached: true` in the error body). */
function isRelayMonthlyLimitBody(rawErrorBody: unknown): boolean {
  if (!isObject(rawErrorBody)) return false;
  if ((rawErrorBody as { limitReached?: unknown }).limitReached === true) {
    return true;
  }
  const nested = (rawErrorBody as { error?: unknown }).error;
  return (
    isObject(nested) &&
    (nested as { limitReached?: unknown }).limitReached === true
  );
}

/** True when the upstream provider (Anthropic today) returned a credit-
 *  balance-depleted 400. Match on the message prefix because Anthropic's
 *  type is generic `invalid_request_error` — the message is the reliable
 *  signal. Covers both the direct format and the enveloped format. */
function isUpstreamCreditDepletedBody(rawErrorBody: unknown): boolean {
  if (!isObject(rawErrorBody)) return false;
  const body = rawErrorBody as {
    type?: unknown;
    message?: unknown;
    error?: unknown;
  };
  const pick = (v: unknown): { type?: string; message?: string } | undefined =>
    isObject(v)
      ? {
          type: isString((v as { type?: unknown }).type)
            ? (v as { type: string }).type
            : undefined,
          message: isString((v as { message?: unknown }).message)
            ? (v as { message: string }).message
            : undefined,
        }
      : undefined;
  const candidates = [pick(body), pick(body.error)];
  return candidates.some(
    (c) =>
      c?.type === 'invalid_request_error' &&
      typeof c.message === 'string' &&
      c.message.toLowerCase().includes('credit balance is too low'),
  );
}

export function formatProviderHttpError(err: unknown): ProviderError {
  const rawErrorBody = detectRawErrorBody(err);
  const streamDiagnostics = detectStreamDiagnostics(err);
  const partialText = detectPartialText(err);
  const isRelay = isRelayError(rawErrorBody);
  // Credit exhaustion matches regardless of relay status: a direct
  // Anthropic 400 "credit balance is too low" still wants the "Use your
  // own API key" affordance so the user can switch credentials.
  const isUpstreamCreditDepleted = isUpstreamCreditDepletedBody(rawErrorBody);
  const isCredentialExhausted =
    isRelayMonthlyLimitBody(rawErrorBody) || isUpstreamCreditDepleted;

  // Handle DOMException AbortError (from AbortController.abort())
  if (err instanceof DOMException && err.name === 'AbortError') {
    return {
      message: 'Request aborted',
      retryable: false,
      isRelayError: false,
      rawErrorBody,
      streamDiagnostics,
      partialText,
    };
  }

  // Disk full — local I/O error, never retryable
  if (isDiskFullError(err)) {
    return {
      message: 'No space left on device. Free up disk space and try again.',
      retryable: false,
      isRelayError: false,
      rawErrorBody,
      streamDiagnostics,
      partialText,
    };
  }

  // Try matching a known SDK error type (connection, abort, HTTP errors)
  const sdkMatch = matchSdkError(err, rawErrorBody);
  if (sdkMatch) {
    return {
      ...sdkMatch,
      // Credential-exhausted errors are not auto-retried (see
      // RetryableInvocationNode.shouldAutoRetry) but the retry panel
      // still surfaces with the "Use your own API key" button, so the
      // `retryable` flag stays true here.
      retryable: isRelay || sdkMatch.retryable || isCredentialExhausted,
      isRelayError: isRelay,
      isCredentialExhausted: isCredentialExhausted || undefined,
      isUpstreamCreditDepleted: isUpstreamCreditDepleted || undefined,
      rawErrorBody,
      streamDiagnostics,
      partialText,
    };
  }

  // Unrecognized error — extract what we can
  const statusCode =
    detectStatusCode(err) ?? inferStatusCodeFromBody(rawErrorBody);
  const statusText = detectStatusText(err, statusCode);
  const provider = detectProvider(err);
  const requestId = detectRequestId(err);
  const fallbackMessage = statusCode
    ? safeGetReasonPhrase(statusCode)
    : undefined;
  const finalMessage =
    extractErrorMessage(err) ?? fallbackMessage ?? 'Provider request failed';
  // No status code on an unrecognized error likely means a network-level failure
  // (DNS, proxy, TLS, etc.) — treat as retryable for safety.
  const retryable =
    isRelay ||
    isCredentialExhausted ||
    (statusCode ? isRetryableStatusCode(statusCode) : true);

  let message = finalMessage;
  if (statusCode) {
    const prefix = statusText
      ? `HTTP ${statusCode} ${statusText}`
      : `HTTP ${statusCode}`;
    message = `${prefix} – ${finalMessage}`;
  }

  return {
    message,
    statusCode,
    statusText,
    provider,
    retryable,
    isRelayError: isRelay,
    isCredentialExhausted: isCredentialExhausted || undefined,
    isUpstreamCreditDepleted: isUpstreamCreditDepleted || undefined,
    requestId,
    rawErrorBody,
    streamDiagnostics,
    partialText,
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

/**
 * Checks if an error indicates the previous_response_id is invalid or expired
 * (OpenAI Responses API).
 *
 * OpenAI surfaces this in two shapes depending on how the SDK serializes the
 * error body:
 *   1. `... param: 'previous_response_id' ...` (parameter name in message)
 *   2. `Previous response with id 'resp_...' not found.` (user-facing message)
 * Both forms indicate the stored id is unusable and the chain must be rebuilt.
 */
export function isPreviousResponseIdError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message.toLowerCase();
  return (
    m.includes('previous_response_id') ||
    (m.includes('previous response') && m.includes('not found'))
  );
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
