import { StatusCodes } from 'http-status-codes';
import { isObject, isString } from '@utils/core';

import { pickStringField } from './errorInspection';

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
export function inferStatusCodeFromBody(
  rawErrorBody: unknown,
): number | undefined {
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

export function isRelayError(rawErrorBody: unknown): boolean {
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
export function isRelayMonthlyLimitBody(rawErrorBody: unknown): boolean {
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
  if (!isObject(rawErrorBody)) return false;
  const candidates = [
    rawErrorBody,
    (rawErrorBody as { error?: unknown }).error,
  ];
  return candidates.some((c) => {
    if (!isObject(c)) return false;
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
