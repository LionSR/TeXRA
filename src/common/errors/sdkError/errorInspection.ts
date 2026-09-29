import { getReasonPhrase, StatusCodes } from 'http-status-codes';
import { Result } from 'effect';
import { safeParseJson } from '@common/parsing/safeParseJson';
import { isObject } from '@utils/core';
import { isNonEmptyString, isString } from '@utils/text/stringUtils';

import { pickStatus } from './sdkErrorKinds';

/** Direct-or-enveloped candidates for a loosely-typed error shape: the value
 *  itself, then its nested carriers at `keys` in order (some SDKs preserve
 *  the full envelope, others unwrap it before it reaches us). Only object
 *  candidates are returned, so callers read fields directly instead of
 *  re-guarding each element. Shared by {@link errorBodyCandidates} (raw
 *  provider error bodies) and `sdkErrorCandidates` (thrown SDK errors). */
function candidateList(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown>[] {
  if (!isObject(value)) return [];
  return [value, ...keys.map((key) => value[key])].filter(isObject);
}

/** Direct-or-enveloped candidate objects for a raw provider error body: the
 *  body itself, then its nested `.error` (some SDKs preserve the full
 *  `{ error: {...} }` envelope, others unwrap it before it reaches us).
 *  Shared by every subscription-limit/credit-depletion body detector,
 *  each of which must check both forms. */
export function errorBodyCandidates(
  rawErrorBody: unknown,
): Record<string, unknown>[] {
  return candidateList(rawErrorBody, ['error']);
}

/** Pick a non-blank string field off an error-body object. Shared by the
 *  ChatGPT-subscription/credit-depletion body detectors, which all read
 *  loosely-typed provider JSON. */
export function pickStringField(v: unknown, key: string): string | undefined {
  if (!isObject(v)) return undefined;
  const value = v[key];
  return isNonEmptyString(value) ? value : undefined;
}

/** Pick a finite-number field off an error-body object. See {@link pickStringField}. */
export function pickNumberField(v: unknown, key: string): number | undefined {
  if (!isObject(v)) return undefined;
  const value = v[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

/** First non-blank string `key` field across the body candidates. */
export function firstBodyStringField(
  rawErrorBody: unknown,
  key: string,
): string | undefined {
  return errorBodyCandidates(rawErrorBody)
    .map((candidate) => pickStringField(candidate, key))
    .find((value) => value !== undefined);
}

/** First finite-number `key` field across the body candidates. */
function firstBodyNumberField(
  rawErrorBody: unknown,
  key: string,
): number | undefined {
  return errorBodyCandidates(rawErrorBody)
    .map((candidate) => pickNumberField(candidate, key))
    .find((value) => value !== undefined);
}

/**
 * What a quota-limit body can report, whichever detector read it: a reset
 * hint, and — only from the ChatGPT (Codex) backend — a plan name. One shape
 * because there is exactly one consumer, the `QUOTA_LIMIT_PARSERS` registry
 * in `providerErrorFormat`, and it reads both fields the same way no matter
 * which route produced them.
 */
export interface QuotaLimitInfo {
  readonly planType?: string;
  readonly resetsInSeconds?: number;
}

/** Match a subscription usage-limit phrase against the error's message — the
 *  body `message` first, then the thrown error's own — returning the reset
 *  hint when the phrase matches. Shared by the route-guarded subscription
 *  detectors (Kimi Code, SuperGrok), which differ only in their bound-route
 *  guard and phrase. */
export function matchUsageLimitMessage(
  err: unknown,
  rawErrorBody: unknown,
  pattern: RegExp,
): QuotaLimitInfo | null {
  const message =
    firstBodyStringField(rawErrorBody, 'message') ??
    pickStringField(err, 'message');
  if (!message || !pattern.test(message)) return null;
  return {
    resetsInSeconds: firstBodyNumberField(rawErrorBody, 'resets_in_seconds'),
  };
}

/** Get reason phrase, returning undefined for unknown codes (getReasonPhrase throws). */
export function safeGetReasonPhrase(statusCode: number): string | undefined {
  return Result.getOrUndefined(Result.try(() => getReasonPhrase(statusCode)));
}

export function getErrorClassNames(err: unknown): string[] {
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

/** Direct-or-enveloped SDK error candidates: the thrown error itself, then
 *  its nested `.response` and `.error` carriers (some SDKs preserve the full
 *  envelope, others unwrap it before it reaches us). Mirrors
 *  {@link errorBodyCandidates} for the analogous raw-body case, via the same
 *  {@link candidateList}. Shared by `detectStatusCode`/`detectStatusText`,
 *  which both check the same fields across the same three shapes. */
function sdkErrorCandidates(err: unknown): Record<string, unknown>[] {
  return candidateList(err, ['response', 'error']);
}

/** Canonical HTTP status extractor for thrown SDK/provider errors. The only
 *  place that knows the candidate field shapes (`status`, `statusCode`,
 *  `code`, `response.status`, `error.status`). */
export function detectStatusCode(err: unknown): number | undefined {
  const [direct, ...nested] = sdkErrorCandidates(err);
  if (!direct) return undefined;
  return (
    pickStatus(direct.status) ??
    pickStatus(direct.statusCode) ??
    pickStatus(direct.code) ??
    nested.map((c) => pickStatus(c.status)).find((v) => v !== undefined)
  );
}

export function detectStatusText(
  err: unknown,
  statusCode?: number,
): string | undefined {
  // A flat `??` reduction, not `.find(v => v !== undefined)`: the original
  // chain skips `null` at every step too, and a candidate's `statusText` can
  // legitimately be `null` (e.g. `response.statusText: null` while
  // `error.statusText` holds the real value).
  const explicit = sdkErrorCandidates(err).reduce<unknown>(
    (acc, c) => acc ?? c.statusText,
    undefined,
  );
  if (isString(explicit) && explicit) return explicit;
  return statusCode ? safeGetReasonPhrase(statusCode) : undefined;
}

/** Extract raw error body from SDK errors for error debugging. */
export function detectRawErrorBody(err: unknown): unknown {
  if (!isObject(err)) {
    return undefined;
  }

  const candidate = err as {
    error?: unknown;
    body?: unknown;
    data?: unknown;
    response?: { data?: unknown };
    message?: unknown;
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
  if (isString(candidate.message) && candidate.message.startsWith('{')) {
    return Result.getOrUndefined(safeParseJson(candidate.message));
  }

  return undefined;
}

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
