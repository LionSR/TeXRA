import { isObject } from '@utils/core';

import {
  detectSdkErrorMetadata,
  hasContextWindowErrorMarker,
} from './errorMetadata';
import { getErrorClassNames } from './errorInspection';

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

// Third-party provider wordings only — do not add TeXRA-internal messages
// here. Internal throws (e.g. ModelHandler.validateTokenLimits) are tagged
// with attachContextWindowError() at the throw site instead, so this
// function doesn't need to string-match a message it doesn't own.
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
 *  Recognizes TeXRA-internal throws via their typed marker (attached with
 *  `attachContextWindowError`) and third-party provider errors via message
 *  pattern matching. */
export function isContextWindowError(err: unknown): boolean {
  if (hasContextWindowErrorMarker(err)) {
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
 * Checks if an error indicates the previous_response_id is invalid or expired
 * (OpenAI Responses API).
 *
 * OpenAI surfaces this in two shapes depending on how the SDK serializes the
 * error body:
 *   1. `... param: 'previous_response_id' ...` (parameter name in message)
 *   2. `Previous response with id 'resp_...' not found.` (user-facing message)
 * Both forms indicate the stored id is unusable and the chain must be rebuilt.
 */
export function isPreviousResponseIdError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message.toLowerCase();
  return (
    m.includes('previous_response_id') ||
    (m.includes('previous response') && m.includes('not found'))
  );
}
