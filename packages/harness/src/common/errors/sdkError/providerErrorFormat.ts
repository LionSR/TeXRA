import { getReasonPhrase } from 'http-status-codes';
import prettyMilliseconds from 'pretty-ms';
import { Result, String as Str } from 'effect';
import { ModelError } from '@texra-ai/llm';

import { quotaFallbackRouteFor } from '@shared/quotaFallbackRoutes';
import type {
  ErrorContext,
  ErrorLogData,
  ExhaustionReason,
  ProviderError,
  ProviderErrorClassification,
} from '@shared/schemas';
import {
  extractErrorMessage,
  toErrorMessage,
} from '@utils/errors/errorMessage';

import { RouteUnavailable } from '../agentErrors';
import {
  findInCauseChain,
  isDiskFullError,
  isUserAbort,
} from '../errorPredicates';
import { attachProviderError, detectProviderError } from './errorMetadata';

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
function formatResetDuration(totalSeconds: number): string {
  const wholeMinutes = Math.floor(Math.max(0, totalSeconds) / 60);
  if (wholeMinutes === 0) return 'less than a minute';
  const flooredMinutes =
    wholeMinutes >= 1440 ? wholeMinutes - (wholeMinutes % 60) : wholeMinutes;
  return prettyMilliseconds(flooredMinutes * 60_000, { unitCount: 2 });
}

/** An HTTP status's reason phrase; undefined for an unknown code (`getReasonPhrase` throws). */
function safeGetReasonPhrase(statusCode: number): string | undefined {
  return Result.getOrUndefined(Result.try(() => getReasonPhrase(statusCode)));
}

/**
 * The user-facing text of a failure: `HTTP {code}[ {text}] – {message}`
 * under a status, the message alone without one. Pure display formatting.
 */
function httpErrorMessage(
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

/** The exhaustion a quota verdict names: its plan's, else the account's credit. */
function exhaustionOf(error: ModelError): ExhaustionReason | undefined {
  const { quota } = error;
  if (quota === undefined) return undefined;
  if (quota.plan === null) return 'upstream-credit';
  return quotaFallbackRouteFor(quota.plan).exhaustionReason;
}

/** The retry panel's classification: an overflowed window, a used-up credential, a missing key. */
function classificationOf(
  error: ModelError | RouteUnavailable,
): ProviderErrorClassification | undefined {
  if (!(error instanceof ModelError)) {
    return error.reason === 'missing-api-key'
      ? { kind: 'missing-api-key' }
      : undefined;
  }
  if (error.kind === 'context-overflow') return { kind: 'context-window' };
  const exhaustion = exhaustionOf(error);
  return exhaustion === undefined ? undefined : { kind: exhaustion };
}

/**
 * The copy of a vendor failure. A used-up plan names the switch the retry
 * offers; an overflowed window says why a retry cannot help; anything else
 * is the reply's message under its status.
 */
function failureMessage(error: ModelError): string {
  const { quota } = error;
  if (quota !== undefined && quota.plan !== null) {
    const route = quotaFallbackRouteFor(quota.plan);
    const plan = quota.planType
      ? ` (${Str.capitalize(quota.planType)} plan)`
      : '';
    const reset =
      quota.resetsInMs === undefined
        ? ''
        : ` Resets in ${formatResetDuration(quota.resetsInMs / 1000)}.`;
    return (
      `${route.retrySourceName} usage limit reached${plan}.${reset}` +
      ` Switch to ${route.retryFallbackName} to keep working, or wait until the limit resets.`
    );
  }
  if (error.kind === 'context-overflow')
    return (
      `${error.message} Retrying would resend the same oversized request. ` +
      'Start a new session, or reduce attached files and tool output.'
    );
  const reason =
    error.status === undefined ? undefined : safeGetReasonPhrase(error.status);
  return httpErrorMessage(
    error.status,
    error.message || reason || 'Provider request failed',
  );
}

/**
 * Whether a person is offered a retry after `error`: whenever llm says the
 * same request can succeed, and after a used-up plan, whose retry carries
 * the switch onto the user's own credential. A missing route is fixed
 * outside the run, so its retry is never offered.
 */
export function offersRetry(error: ModelError | RouteUnavailable): boolean {
  if (!(error instanceof ModelError)) return false;
  return error.retryable || error.kind === 'quota-exhausted';
}

/**
 * A model call's failure as the person reads it, worded once for the retry a
 * run records (`failureInfo`) and for a failure formatted fresh: a helper
 * call, which records nothing, or a run that ended before recording one.
 */
export function providerErrorOf(
  error: ModelError | RouteUnavailable,
): ProviderError {
  const vendor = error instanceof ModelError ? error : undefined;
  const status = vendor?.status;
  const statusText =
    status === undefined ? undefined : safeGetReasonPhrase(status);
  const classification = classificationOf(error);
  return {
    message: vendor === undefined ? error.message : failureMessage(vendor),
    userRetryable: offersRetry(error),
    ...(status !== undefined && { statusCode: status }),
    ...(statusText !== undefined && { statusText }),
    ...(classification !== undefined && { classification }),
    ...(vendor?.requestId !== undefined && { requestId: vendor.requestId }),
    ...(vendor?.cause !== undefined && { rawErrorBody: vendor.cause }),
  };
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
  if (known !== undefined) return providerErrorOf(known);
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
  const cached = findInCauseChain(err, detectProviderError);
  if (cached) {
    attachProviderError(err, cached);
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
