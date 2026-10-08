import { getReasonPhrase } from 'http-status-codes';
import prettyMilliseconds from 'pretty-ms';
import { Result } from 'effect';
import { ModelError } from '@texra-ai/llm';

import type {
  ErrorContext,
  ErrorLogData,
  ProviderError,
} from '@shared/schemas';
import {
  extractErrorMessage,
  toErrorMessage,
} from '@utils/errors/errorMessage';

import { RouteUnavailable } from '../agentErrors';
import { findInCauseChain, isDiskFullError } from '../errorPredicates';
import { isUserAbort } from './errorPatterns';
import { providerErrorMetadata } from './errorMetadata';

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

/** An HTTP status's reason phrase; undefined for an unknown code (`getReasonPhrase` throws). */
export function safeGetReasonPhrase(statusCode: number): string | undefined {
  return Result.getOrUndefined(Result.try(() => getReasonPhrase(statusCode)));
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

/** A failure formatted fresh: an abort, a full disk, a model failure, or any error's message. */
function formatFailure(err: unknown): ProviderError {
  if (isUserAbort(err))
    return { message: 'Request aborted', userRetryable: false };
  if (isDiskFullError(err)) {
    return {
      message: 'No space left on device. Free up disk space and try again.',
      userRetryable: false,
    };
  }
  const known = findInCauseChain(err, (cause) =>
    cause instanceof ModelError || cause instanceof RouteUnavailable
      ? cause
      : undefined,
  );
  if (known instanceof RouteUnavailable) {
    return {
      message: known.message,
      userRetryable: false,
      ...(known.reason === 'missing-api-key' && {
        classification: { kind: 'missing-api-key' as const },
      }),
    };
  }
  if (known instanceof ModelError) {
    const statusText =
      known.status === undefined
        ? undefined
        : safeGetReasonPhrase(known.status);
    return {
      message: httpErrorMessage(known.status, known.message, statusText),
      userRetryable: known.retryable,
      ...(known.status !== undefined && { statusCode: known.status }),
      ...(statusText !== undefined && { statusText }),
      ...(known.kind === 'context-overflow' && {
        classification: { kind: 'context-window' as const },
      }),
      ...(known.requestId !== undefined && { requestId: known.requestId }),
      ...(known.cause !== undefined && { rawErrorBody: known.cause }),
    };
  }
  return {
    message: extractErrorMessage(err) ?? 'Provider request failed',
    // No status: likely a network-level failure; offer the retry.
    userRetryable: true,
  };
}

/**
 * Normalize a failure for display and logs. A `ProviderError` a run recorded
 * and carried back (attached on its error, possibly on a deeper `cause`) is
 * recovered as recorded; anything else is formatted fresh, uncached.
 */
export function normalizeProviderError(err: unknown): ProviderError {
  const cached = findInCauseChain(err, providerErrorMetadata.detect);
  if (cached) {
    providerErrorMetadata.attach(err, cached);
    return cached;
  }
  return formatFailure(err);
}

/** The user-facing message of any failure. */
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
