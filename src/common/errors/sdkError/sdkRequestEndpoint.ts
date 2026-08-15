import { isObject } from '@utils/core';

/**
 * Side channel carrying the endpoint a thrown SDK error was sent to, for SDKs
 * whose error type carries status/body/headers but no request config (the
 * OpenAI SDK's `APIError`). Endpoint-scoped error detection (Kimi Code
 * subscription usage limits) reads it instead of re-deriving the endpoint.
 *
 * A WeakMap rather than a property stamp: the value travels with the error
 * identity, so stamping stays strictly best-effort — it cannot mask the
 * original failure by throwing on a frozen or sealed error, and it never
 * overwrites a `request.baseURL` the SDK set itself.
 */
const requestBaseURLs = new WeakMap<object, string>();

/** Record the endpoint `err` was sent to, unless it already carries one. */
export function attachSdkRequestBaseURL(err: unknown, baseURL: string): void {
  if (!isObject(err)) return;
  if (detectSdkRequestBaseURL(err) !== undefined) return;
  requestBaseURLs.set(err, baseURL);
}

/** The endpoint recorded for `err`, or the SDK's own `request.baseURL`. */
export function detectSdkRequestBaseURL(err: unknown): string | undefined {
  if (!isObject(err)) return undefined;
  const own = (err as { request?: { baseURL?: unknown } }).request;
  if (typeof own?.baseURL === 'string') return own.baseURL;
  return requestBaseURLs.get(err);
}
