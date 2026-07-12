import { isObject, isString } from '@utils/core';

import {
  detectSdkErrorMetadata,
  hasContextWindowErrorMarker,
} from './errorMetadata';
import { detectRawErrorBody, getErrorClassNames } from './errorInspection';

/** Max tail size (chars) for partial text attached to streaming errors.
 *  4KB is enough for a "continue from [tail]" prompt and UI display,
 *  while staying well under webview message-size limits. */
export const PARTIAL_TEXT_TAIL_MAX = 4096;

/** Returns the last `maxChars` of `text`. If `text` is shorter, returns it
 *  as-is. Used by streaming handlers to cap partial output on error. */
export function takeTail(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(text.length - maxChars);
}

/** True if `err` is an SDK or AbortController user-abort error. */
export function isUserAbort(err: unknown): boolean {
  if (detectSdkErrorMetadata(err)?.kind === 'user_abort') return true;
  if (getErrorClassNames(err).includes('APIUserAbortError')) return true;
  return isObject(err) && (err as { name?: unknown }).name === 'AbortError';
}

/**
 * OpenAI's own error code for a prompt that overflows the model's context
 * window — a stable, versioned field of its API error contract (`error.code`
 * in the JSON body, flattened onto `APIError#code` by the SDK), not prose.
 * Checked directly off the error and off a nested raw body (covers
 * `WebSocketError#error.code` and any wrapper that preserves the response's
 * `error` object) so this survives even if the wording OpenAI puts in
 * `error.message` changes between model generations.
 */
const OPENAI_CONTEXT_WINDOW_ERROR_CODE = 'context_length_exceeded';

function hasOpenAIContextWindowErrorCode(err: unknown): boolean {
  const isMatch = (code: unknown): boolean =>
    isString(code) && code === OPENAI_CONTEXT_WINDOW_ERROR_CODE;

  if (!isObject(err)) return false;
  if (isMatch((err as { code?: unknown }).code)) return true;

  const body = detectRawErrorBody(err);
  return isObject(body) && isMatch((body as { code?: unknown }).code);
}

// Message wordings for providers (Anthropic, Google) whose SDKs expose no
// finer-grained error code for this failure than a generic 400 — the message
// is the only signal they give. Do not add TeXRA-internal messages here.
// Internal throws (e.g. ModelHandler.validateTokenLimits) are tagged with
// attachContextWindowError() at the throw site instead, so this function
// doesn't need to string-match a message it doesn't own.
const CONTEXT_WINDOW_PATTERNS = [
  'exceeds context window', // Anthropic
  'exceeds the context window', // OpenAI Responses API
  'context length exceeded', // Google
  'maximum context length', // OpenAI
  'token limit exceeded', // Anthropic
  'too many tokens', // OpenAI
  'input too long', // Google
] as const;

/** Checks if an error is a context window violation (should not be retried).
 *  Recognizes, in order: TeXRA-internal throws via their typed marker
 *  (attached with `attachContextWindowError`); OpenAI's native `code` field
 *  (present on any SDK-thrown `APIError` and on our own error wrappers that
 *  preserve the provider's raw body); and, only where no provider error code
 *  exists, third-party message pattern matching as a last resort. */
export function isContextWindowError(err: unknown): boolean {
  if (hasContextWindowErrorMarker(err)) {
    return true;
  }
  if (hasOpenAIContextWindowErrorCode(err)) {
    return true;
  }
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
 * True when `err` (or a nested `error` body, e.g. `WebSocketError#error`)
 * carries OpenAI's native `param` field naming `previous_response_id` — the
 * SDK flattens this from the JSON body onto `APIError#param` for any 4xx
 * response, and `ResponseErrorEvent#param` carries it for the WebSocket
 * transport's connection-level `error` event. This identifies the invalid
 * parameter directly instead of pattern-matching for its name inside prose.
 */
function hasPreviousResponseIdErrorParam(err: unknown): boolean {
  const isMatch = (param: unknown): boolean =>
    isString(param) && param === 'previous_response_id';

  if (!isObject(err)) return false;
  if (isMatch((err as { param?: unknown }).param)) return true;

  const body = detectRawErrorBody(err);
  return isObject(body) && isMatch((body as { param?: unknown }).param);
}

/**
 * Checks if an error indicates the previous_response_id is invalid or expired
 * (OpenAI Responses API): the stored id is unusable and the chain must be
 * rebuilt from local history.
 *
 * Prefers the native `param` field (see {@link hasPreviousResponseIdErrorParam}).
 * Where that isn't available — e.g. a 404 "not found" response, which OpenAI
 * reports without a `param` since no parameter name applies to a missing
 * resource — falls back to matching the user-facing message text.
 */
export function isPreviousResponseIdError(err: unknown): boolean {
  if (hasPreviousResponseIdErrorParam(err)) return true;
  if (!(err instanceof Error)) return false;
  const m = err.message.toLowerCase();
  return (
    m.includes('previous_response_id') ||
    (m.includes('previous response') && m.includes('not found'))
  );
}
