import { getReasonPhrase } from 'http-status-codes';
import { Predicate, Result } from 'effect';
import { safeParseJson } from '@common/parsing/safeParseJson';
import { isNonEmptyString } from '@utils/text/stringUtils';

import { pickStatus } from './sdkErrorKinds';

/** Direct-or-enveloped candidates for a loosely-typed error shape: the value
 *  itself, then its nested carriers at `keys` in order (some SDKs preserve
 *  the full envelope, others unwrap it before it reaches us). Only object
 *  candidates are returned, so callers read fields directly instead of
 *  re-guarding each element. */
function candidateList(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown>[] {
  if (!Predicate.isObject(value)) return [];
  return [value, ...keys.map((key) => value[key])].filter(Predicate.isObject);
}

/** First non-blank string `key` field across a raw error body and its
 *  nested `.error` envelope. */
export function firstBodyStringField(
  rawErrorBody: unknown,
  key: string,
): string | undefined {
  return candidateList(rawErrorBody, ['error'])
    .map((candidate) => candidate[key])
    .find(isNonEmptyString);
}

/** Get reason phrase, returning undefined for unknown codes (getReasonPhrase throws). */
export function safeGetReasonPhrase(statusCode: number): string | undefined {
  return Result.getOrUndefined(Result.try(() => getReasonPhrase(statusCode)));
}

export function getErrorClassNames(err: unknown): string[] {
  if (!Predicate.isObject(err)) return [];

  const classNames = new Set<string>();
  let prototype = Object.getPrototypeOf(err);
  while (prototype && prototype !== Object.prototype) {
    const className = prototype.constructor?.name;
    if (typeof className === 'string' && className.length > 0) {
      classNames.add(className);
    }
    prototype = Object.getPrototypeOf(prototype);
  }
  return [...classNames];
}

/** Direct-or-enveloped SDK error candidates: the thrown error itself, then
 *  its nested `.response` and `.error` carriers. Shared by
 *  `detectStatusCode`/`detectStatusText`, which both check the same fields
 *  across the same three shapes. */
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
  if (typeof explicit === 'string' && explicit) return explicit;
  return statusCode ? safeGetReasonPhrase(statusCode) : undefined;
}

/** Extract raw error body from SDK errors for error debugging. */
export function detectRawErrorBody(err: unknown): unknown {
  if (!Predicate.isObject(err)) {
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
  if (
    typeof candidate.message === 'string' &&
    candidate.message.startsWith('{')
  ) {
    return Result.getOrUndefined(safeParseJson(candidate.message));
  }

  return undefined;
}
