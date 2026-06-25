import {
  type ErrorContext,
  type ErrorLogData,
  type ProviderError,
} from '@shared/schemas';
import { extractErrorMessage, toErrorMessage } from '../errorMessage';
import { isDiskFullError } from '../errorPredicates';
import {
  detectPartialText,
  detectSdkErrorMetadata,
  detectStreamDiagnostics,
  providerErrorMetadata,
} from './errorMetadata';
import {
  detectProvider,
  detectRawErrorBody,
  detectRequestId,
  detectStatusCode,
  detectStatusText,
  getErrorClassNames,
  safeGetReasonPhrase,
} from './errorInspection';
import {
  inferStatusCodeFromBody,
  isRelayError,
  isRelayMonthlyLimitBody,
  isRelayMonthlyLimitMessage,
  isUpstreamCreditDepletedBody,
} from './relayDetection';
import {
  type SdkErrorEntry,
  SDK_ERRORS,
  SDK_ERRORS_BY_KIND,
  isRetryableStatusCode,
} from './sdkErrorKinds';

/** Partial result before relay detection (isRelayError/rawErrorBody added later). */
type SdkMatchResult = Omit<ProviderError, 'isRelayError' | 'rawErrorBody'>;

function matchLegacySdkError(err: unknown): SdkErrorEntry | undefined {
  const errorClassNames = getErrorClassNames(err);
  return SDK_ERRORS.find(({ classNames }) =>
    classNames.some((className) => errorClassNames.includes(className)),
  );
}

/** Match known SDK error types and return structured error details. */
function matchSdkError(
  err: unknown,
  rawErrorBody: unknown,
): SdkMatchResult | undefined {
  const metadata = detectSdkErrorMetadata(err);
  const entry =
    (metadata ? SDK_ERRORS_BY_KIND.get(metadata.kind) : undefined) ??
    matchLegacySdkError(err);
  if (!entry) {
    return undefined;
  }

  const provider = metadata?.provider ?? detectProvider(err);
  const requestId = detectRequestId(err);

  // Message-only errors (connection, abort) - use the entry's message
  if (entry.message !== undefined) {
    return {
      message: entry.message,
      provider,
      userRetryable: entry.userRetryable ?? false,
      requestId,
    };
  }

  // HTTP errors - detect status code from error object, SDK class, or error body.
  // If detectStatusCode returns a non-error code (< 400), it's likely misleading
  // (e.g., SSE connection status 200 while the actual error is in the body),
  // so prefer the body-inferred status code in that case.
  const rawStatusCode = metadata?.statusCode ?? detectStatusCode(err);
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
    // SDK errors without status codes are unusual - be conservative and don't offer retry
    return {
      message: finalMessage,
      provider,
      userRetryable: false,
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
    userRetryable: isRetryableStatusCode(statusCode),
    requestId,
  };
}

/**
 * Builds a fresh `ProviderError` without caching it on the thrown value.
 *
 * @internal Production code should call {@link normalizeProviderError}, the
 * single public entry that classifies once and caches the result on the
 * error. This stays module-exported for tests that assert raw formatting.
 */
export function formatProviderHttpError(err: unknown): ProviderError {
  const rawErrorBody = detectRawErrorBody(err);
  const streamDiagnostics = detectStreamDiagnostics(err);
  const partialText = detectPartialText(err);
  const extractedMessage = extractErrorMessage(err);
  const isRelayMonthlyLimitByMessage =
    isRelayMonthlyLimitMessage(extractedMessage);
  const isRelay = isRelayError(rawErrorBody) || isRelayMonthlyLimitByMessage;
  // Credit exhaustion matches regardless of relay status: a direct
  // Anthropic 400 "credit balance is too low" still wants the "Use your
  // own API key" affordance so the user can switch credentials.
  const isUpstreamCreditDepleted = isUpstreamCreditDepletedBody(rawErrorBody);
  const isCredentialExhausted =
    isRelayMonthlyLimitBody(rawErrorBody) ||
    isRelayMonthlyLimitByMessage ||
    isUpstreamCreditDepleted;

  // Handle DOMException AbortError (from AbortController.abort())
  if (err instanceof DOMException && err.name === 'AbortError') {
    return {
      message: 'Request aborted',
      userRetryable: false,
      isRelayError: false,
      rawErrorBody,
      streamDiagnostics,
      partialText,
    };
  }

  // Disk full — local I/O error, no retry will help
  if (isDiskFullError(err)) {
    return {
      message: 'No space left on device. Free up disk space and try again.',
      userRetryable: false,
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
      // Credential-exhausted errors keep userRetryable=true so the retry
      // panel surfaces with the "Use your own API key" affordance, but
      // shouldAutoRetry separately suppresses auto-retry for them — a
      // fresh attempt with the same depleted credential would just fail.
      userRetryable: isRelay || sdkMatch.userRetryable || isCredentialExhausted,
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
    extractedMessage ?? fallbackMessage ?? 'Provider request failed';
  // No status code on an unrecognized error likely means a network-level failure
  // (DNS, proxy, TLS, etc.) — show retry button for safety.
  const userRetryable =
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
    userRetryable,
    isRelayError: isRelay,
    isCredentialExhausted: isCredentialExhausted || undefined,
    isUpstreamCreditDepleted: isUpstreamCreditDepleted || undefined,
    requestId,
    rawErrorBody,
    streamDiagnostics,
    partialText,
  };
}

function detectCachedProviderError(err: unknown): ProviderError | undefined {
  for (
    let current: unknown = err;
    current != null && typeof current === 'object';
    current = (current as { cause?: unknown }).cause
  ) {
    const cached = providerErrorMetadata.detect(current);
    if (cached) return cached;
  }
  return undefined;
}

/**
 * Normalize an upstream or SDK error. If a structured `ProviderError` was
 * explicitly attached at a provider/flow boundary (possibly on a deeper
 * `cause`), recover it; otherwise format the error fresh. Retry code consumes
 * this helper so provider-boundary code owns classification while downstream
 * layers only read the shape.
 */
export function normalizeProviderError(err: unknown): ProviderError {
  const cached = detectCachedProviderError(err);
  if (cached) {
    // Migrate an explicitly-attached ProviderError from a deeper cause onto the
    // wrapper so later reads skip the chain walk.
    providerErrorMetadata.attach(err, cached);
    return cached;
  }

  // Compute fresh but DO NOT cache the result: a caller may format an error for
  // logging before later metadata (streamDiagnostics / partialText) is attached
  // to it, and a deliberately status-stripped wrapper (e.g. background-polling
  // 404) must not inherit a status cached by an incidental normalize on its
  // cause. Only explicit `attachProviderError` at provider/flow boundaries seeds
  // the cache the lookup above recovers.
  return formatProviderHttpError(err);
}

export function getSdkErrorMessage(err: unknown): string {
  return normalizeProviderError(err).message;
}

/** Builds consistent error data for logging with MESSAGE_TYPES.ERROR. */
export function buildErrorLogData(
  err: unknown,
  context?: ErrorContext,
): ErrorLogData {
  const formatted = normalizeProviderError(err);
  const rawMessage = toErrorMessage(err);

  return {
    ...formatted,
    rawMessage: rawMessage !== formatted.message ? rawMessage : undefined,
    operation: context?.operation,
    model: context?.model,
  };
}
