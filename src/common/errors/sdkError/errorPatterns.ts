import { isObject } from '@utils/core';

import { hasContextWindowErrorMarker } from './errorMetadata';
import { detectRawErrorBody, getErrorClassNames } from './errorInspection';

/** True if `err` is an SDK or AbortController user-abort error. */
export function isUserAbort(err: unknown): boolean {
  if (getErrorClassNames(err).includes('APIUserAbortError')) return true;
  return isObject(err) && (err as { name?: unknown }).name === 'AbortError';
}

/**
 * True when `err` carries a provider's own native error field with `expected`,
 * checked directly off the error and off a nested raw body (covers
 * `WebSocketError#error` and any wrapper that preserves the response's `error`
 * object). Reading the provider's structured contract this way survives
 * changes to the prose it puts in `error.message`.
 */
function hasNativeErrorField(
  err: unknown,
  field: 'code' | 'param',
  expected: string,
): boolean {
  const read = (source: unknown): unknown =>
    isObject(source) ? (source as Record<string, unknown>)[field] : undefined;

  if (!isObject(err)) return false;
  return read(err) === expected || read(detectRawErrorBody(err)) === expected;
}

/**
 * OpenAI's own error code for a prompt that overflows the model's context
 * window — a stable, versioned field of its API error contract (`error.code`
 * in the JSON body, flattened onto `APIError#code` by the SDK), not prose.
 */
const OPENAI_CONTEXT_WINDOW_ERROR_CODE = 'context_length_exceeded';

// Message wordings for providers (Anthropic, Google) whose SDKs expose no
// finer-grained error code for this failure than a generic 400 — the message
// is the only signal they give. Do not add TeXRA-internal messages here.
// Internal throws (e.g. run/modelFailure.ts) are tagged with
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
  if (hasNativeErrorField(err, 'code', OPENAI_CONTEXT_WINDOW_ERROR_CODE)) {
    return true;
  }
  if (!(err instanceof Error)) {
    return false;
  }
  const message = err.message.toLowerCase();
  return CONTEXT_WINDOW_PATTERNS.some((pattern) => message.includes(pattern));
}
