import { isObject } from '@utils/core';

/** Credential route stamped on a thrown SDK error. Mirrors
 *  `ModelCredentialRoute` without importing `@agent` (common → agent is
 *  a forbidden architecture edge). */
export type SdkCredentialRoute =
  | 'api-key'
  | 'chatgpt-subscription'
  | 'xai-subscription'
  | 'openrouter'
  | 'relay';

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

/**
 * Side channel carrying the credential route a thrown SDK error was sent
 * on. SuperGrok and ChatGPT share `api.x.ai` / `api.openai.com` with the
 * API-key path, so endpoint inspection cannot tell a subscription quota
 * failure from a key rate-limit — the route stamp can.
 */
const requestCredentialRoutes = new WeakMap<object, SdkCredentialRoute>();

/** Record the credential route `err` was sent on, unless one is already set. */
export function attachSdkCredentialRoute(
  err: unknown,
  route: SdkCredentialRoute,
): void {
  if (!isObject(err)) return;
  if (detectSdkCredentialRoute(err) !== undefined) return;
  requestCredentialRoutes.set(err, route);
}

/** The credential route recorded for `err`. */
export function detectSdkCredentialRoute(
  err: unknown,
): SdkCredentialRoute | undefined {
  return isObject(err) ? requestCredentialRoutes.get(err) : undefined;
}
