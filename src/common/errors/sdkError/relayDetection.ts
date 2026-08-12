import { StatusCodes } from 'http-status-codes';
import { isString } from '@utils/core';

import {
  errorBodyCandidates,
  pickNumberField,
  pickStringField,
} from './errorInspection';

/**
 * Maps provider error type/code strings to their corresponding HTTP status
 * codes. Used to recover the status code when SDK error objects lose it
 * (e.g., streaming errors that produce generic APIError instances).
 */
const ERROR_TYPE_OR_CODE_TO_STATUS: Record<string, number> = {
  invalid_request_error: StatusCodes.BAD_REQUEST, // 400
  authentication_error: StatusCodes.UNAUTHORIZED, // 401
  permission_error: StatusCodes.FORBIDDEN, // 403
  not_found_error: StatusCodes.NOT_FOUND, // 404
  request_too_large: StatusCodes.REQUEST_TOO_LONG, // 413
  rate_limit_error: StatusCodes.TOO_MANY_REQUESTS, // 429
  service_unavailable_error: StatusCodes.SERVICE_UNAVAILABLE, // 503
  server_is_overloaded: StatusCodes.SERVICE_UNAVAILABLE, // 503
  api_error: StatusCodes.INTERNAL_SERVER_ERROR, // 500
  server_error: StatusCodes.INTERNAL_SERVER_ERROR, // 500
  timeout_error: StatusCodes.REQUEST_TIMEOUT, // 408
  overloaded_error: 529,
};

/**
 * Infers an HTTP status code from a provider error type/code in the raw body.
 * Handles both enveloped errors such as
 * `{ type: "error", error: { type: "api_error" } }` and direct errors such as
 * `{ type: "server_error", code: "server_error" }`.
 *
 * The nested path is checked first because Anthropic's canonical envelope uses
 * `type: "error"` at the top level (not a real error type), with the actual
 * error classification in `error.type`.
 */
export function inferStatusCodeFromBody(
  rawErrorBody: unknown,
): number | undefined {
  // Nested-first, per the docstring above (reversed from errorBodyCandidates'
  // direct-first default). `errorBodyCandidates` returns a fresh array, so the
  // in-place reverse touches nothing the caller holds.
  const candidates = errorBodyCandidates(rawErrorBody).reverse();
  for (const candidate of candidates) {
    for (const field of ['type', 'code'] as const) {
      const value = candidate[field];
      if (!isString(value)) continue;
      const statusCode = ERROR_TYPE_OR_CODE_TO_STATUS[value];
      if (statusCode !== undefined) return statusCode;
    }
  }
  return undefined;
}

export function isRelayError(rawErrorBody: unknown): boolean {
  return errorBodyCandidates(rawErrorBody).some(
    (candidate) => '_relay' in candidate,
  );
}

function hasRelayBooleanFlag(rawErrorBody: unknown, field: string): boolean {
  return errorBodyCandidates(rawErrorBody).some(
    (candidate) => candidate[field] === true,
  );
}

/** True when the relay rejected the request due to the user's monthly
 *  spending limit being reached (supabase/functions/relay marks this with
 *  `limitReached: true` in the error body). */
export function isRelayMonthlyLimitBody(rawErrorBody: unknown): boolean {
  return hasRelayBooleanFlag(rawErrorBody, 'limitReached');
}

/** True when the relay's per-user request or concurrency gate rejected a call. */
export function isRelayRequestLimitBody(rawErrorBody: unknown): boolean {
  return hasRelayBooleanFlag(rawErrorBody, 'requestLimitReached');
}

/** Admission mode reported by the relay request gate. */
export function getRelayRequestLimitReason(
  rawErrorBody: unknown,
): 'concurrency' | 'rate' | undefined {
  for (const candidate of errorBodyCandidates(rawErrorBody)) {
    const reason = pickStringField(candidate, 'reason');
    if (reason === 'concurrency' || reason === 'rate') return reason;
  }
  return undefined;
}

/** Retry delay returned by the relay's per-user request gate. */
export function getRelayRequestLimitRetryAfterMs(
  rawErrorBody: unknown,
): number | undefined {
  for (const candidate of errorBodyCandidates(rawErrorBody)) {
    const seconds = pickNumberField(candidate, 'retryAfterSeconds');
    if (seconds !== undefined && seconds >= 0) return seconds * 1000;
  }
  return undefined;
}

/** True only when a provider body explicitly identifies a model-scoped limit. */
export function isModelScopedRateLimitBody(rawErrorBody: unknown): boolean {
  return errorBodyCandidates(rawErrorBody).some((candidate) => {
    const scope =
      pickStringField(candidate, 'scope') ??
      pickStringField(candidate, 'rate_limit_scope') ??
      pickStringField(candidate, 'rateLimitScope');
    return scope?.toLowerCase() === 'model';
  });
}

export function isRelayMonthlyLimitMessage(
  message: string | undefined,
): boolean {
  return (
    message?.toLowerCase().includes('monthly spending limit reached') ?? false
  );
}

/** True when the upstream provider returned a credit/quota exhaustion body.
 *  Anthropic uses a generic `invalid_request_error`, so its message remains
 *  part of the signal; OpenAI may report `insufficient_quota` directly.
 *  Covers both the direct format and the enveloped format. */
export function isUpstreamCreditDepletedBody(rawErrorBody: unknown): boolean {
  return errorBodyCandidates(rawErrorBody).some((c) => {
    const type = pickStringField(c, 'type');
    const code = pickStringField(c, 'code');
    const message = pickStringField(c, 'message')?.toLowerCase();
    if (code === 'insufficient_quota' || type === 'insufficient_quota') {
      return true;
    }
    if (
      type === 'invalid_request_error' &&
      message?.includes('credit balance is too low')
    ) {
      return true;
    }
    return message?.includes('exceeded your current quota') ?? false;
  });
}
