import { StatusCodes } from 'http-status-codes';
import prettyMilliseconds from 'pretty-ms';

import {
  type ErrorContext,
  type ErrorLogData,
  type ProviderError,
  type ProviderErrorClassification,
  getExhaustionReason,
} from '@shared/schemas';
import {
  extractErrorMessage,
  toErrorMessage,
} from '@utils/errors/errorMessage';

import { findInCauseChain, isDiskFullError } from '../errorPredicates';
import { isUserAbort } from './errorPatterns';
import {
  hasContextWindowErrorMarker,
  hasMissingApiKeyErrorMarker,
  providerErrorMetadata,
} from './errorMetadata';
import {
  detectRawErrorBody,
  detectStatusCode,
  detectStatusText,
  firstBodyStringField,
  safeGetReasonPhrase,
} from './errorInspection';
import { isRetryableStatusCode } from './sdkErrorKinds';

/**
 * Format a coarse "1d 20h" / "20h 22m" / "5m" duration from a second count.
 * Day+hour, hour+minute, or minute granularity is plenty for a reset-window
 * hint; sub-minute collapses to a friendly phrase. Pure (no clock read), so it
 * stays usable from this synchronous formatter. Backed by `pretty-ms` (top 2
 * units) rather than hand-rolled day/hour/minute math — minutes are truncated
 * once the duration reaches a day, matching the "day granularity drops
 * minutes" rule of the original hand-rolled formatter (pretty-ms would
 * otherwise back-fill a zero hour component with minutes, e.g. "1d 58m").
 */
export function formatResetDuration(totalSeconds: number): string {
  const wholeMinutes = Math.floor(Math.max(0, totalSeconds) / 60);
  if (wholeMinutes === 0) return 'less than a minute';
  const flooredMinutes =
    wholeMinutes >= 1440 ? wholeMinutes - (wholeMinutes % 60) : wholeMinutes;
  return prettyMilliseconds(flooredMinutes * 60_000, { unitCount: 2 });
}

/**
 * The user-facing text of a failure: `HTTP {code}[ {text}] – {message}`
 * under a status, the message alone without one. Pure display formatting.
 */
export function httpErrorMessage(
  statusCode: number | undefined,
  message: string,
  statusText = statusCode === undefined
    ? undefined
    : safeGetReasonPhrase(statusCode),
): string {
  return statusCode
    ? `HTTP ${statusCode}${statusText ? ` ${statusText}` : ''} – ${message}`
    : message;
}

/**
 * Builds a fresh `ProviderError` without caching it on the thrown value.
 * The package judges its own failures (`classifyModelFailure` reads that
 * verdict); this formats any other error: its status, its message, and the
 * classification its markers carry.
 *
 * @internal Production code should call {@link normalizeProviderError}, the
 * single public entry that classifies once and caches the result on the
 * error. This stays module-exported for tests that assert raw formatting.
 */
export function formatProviderHttpError(err: unknown): ProviderError {
  const rawErrorBody = detectRawErrorBody(err);
  const extractedMessage = extractErrorMessage(err);
  const hasMissingApiKey = hasMissingApiKeyErrorMarker(err);
  let classification: ProviderErrorClassification | undefined;
  if (hasMissingApiKey) {
    classification = { kind: 'missing-api-key' };
  } else if (hasContextWindowErrorMarker(err)) {
    classification = { kind: 'context-window' };
  }

  // Terminal failures (user abort, local disk-full): never retryable and never
  // a credential affordance.
  function terminalError(
    message: string,
    terminalClassification?: ProviderErrorClassification,
  ): ProviderError {
    return {
      message,
      userRetryable: false,
      classification: terminalClassification,
      rawErrorBody,
    };
  }

  // An AbortController abort or an SDK user-abort error.
  if (isUserAbort(err)) {
    return terminalError('Request aborted');
  }

  // Disk full — local I/O error, no retry will help
  if (isDiskFullError(err)) {
    return terminalError(
      'No space left on device. Free up disk space and try again.',
    );
  }

  const statusCode = detectStatusCode(err);

  // A context-window overflow marked at its throw site is deterministic: a
  // retry resends the same oversized payload and fails again. Guarded on the
  // status code so a retryable failure keeps its retry affordance.
  if (
    hasContextWindowErrorMarker(err) &&
    (statusCode === undefined || !isRetryableStatusCode(statusCode))
  ) {
    return terminalError(
      `${extractedMessage ?? 'Conversation exceeds the model context window.'} ` +
        'Retrying would resend the same oversized request. Start a new ' +
        'session, or reduce attached files and tool output.',
      hasMissingApiKey
        ? { kind: 'missing-api-key' }
        : { kind: 'context-window' },
    );
  }

  const statusText = detectStatusText(err, statusCode);
  const message = httpErrorMessage(
    statusCode,
    extractedMessage ??
      firstBodyStringField(rawErrorBody, 'message') ??
      (statusCode ? safeGetReasonPhrase(statusCode) : undefined) ??
      'Provider request failed',
    statusText,
  );
  return {
    classification,
    rawErrorBody,
    message,
    statusCode,
    statusText,
    // No status code likely means a network-level failure (DNS, proxy, TLS,
    // etc.) — show the retry button for safety.
    userRetryable: statusCode ? isRetryableStatusCode(statusCode) : true,
  };
}

/**
 * Normalize an upstream or SDK error. If a structured `ProviderError` was
 * explicitly attached at a provider/flow boundary (possibly on a deeper
 * `cause`), recover it; otherwise format the error fresh. Retry code consumes
 * this helper so provider-boundary code owns classification while downstream
 * layers only read the shape.
 */
export function normalizeProviderError(err: unknown): ProviderError {
  const cached = findInCauseChain(err, providerErrorMetadata.detect);
  if (cached) {
    // Cache metadata is canonical and validated by providerErrorMetadata.
    // Copy a value found on a deeper cause onto the wrapper so later reads can
    // skip the cause-chain walk.
    providerErrorMetadata.attach(err, cached);
    return cached;
  }

  // Compute fresh but DO NOT cache the result: a caller may format an error
  // for logging before it is classified, and a deliberately status-stripped
  // wrapper must not inherit a status cached by an incidental normalize on
  // its cause. Only explicit `attachProviderError` at provider/flow
  // boundaries seeds the cache the lookup above recovers.
  return formatProviderHttpError(err);
}

/** Whether repeating the same provider request can recover without user action. */
export function isProviderErrorAutoRetryable(err: unknown): boolean {
  if (isUserAbort(err) || hasContextWindowErrorMarker(err)) {
    return false;
  }

  const formatted = normalizeProviderError(err);
  return (
    formatted.userRetryable &&
    getExhaustionReason(formatted) === undefined &&
    formatted.statusCode !== StatusCodes.UNAUTHORIZED &&
    formatted.statusCode !== StatusCodes.FORBIDDEN
  );
}

export function getSdkErrorMessage(err: unknown): string {
  return normalizeProviderError(err).message;
}

/** Builds consistent error data for logging with MESSAGE_TYPES.ERROR. */
export function buildErrorLogData(
  err: unknown,
  context?: ErrorContext,
): ErrorLogData {
  const { rawErrorBody: _body, ...formatted } = normalizeProviderError(err);
  const rawMessage = toErrorMessage(err);

  return {
    ...formatted,
    rawMessage: rawMessage !== formatted.message ? rawMessage : undefined,
    operation: context?.operation,
    model: context?.model,
  };
}
