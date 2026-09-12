import { isObject } from '@utils/core';

/** Credential route stamped on a thrown SDK error. Mirrors
 *  `ModelCredentialRoute` without importing `@agent` (common → agent is
 *  a forbidden architecture edge). */
export type SdkCredentialRoute =
  'api-key' | 'chatgpt-subscription' | 'xai-subscription' | 'openrouter';

/**
 * Side channel carrying the endpoint a thrown SDK error was sent to, for SDKs
 * whose error type carries status/body/headers but no request config (the
 * OpenAI SDK's `APIError`). Endpoint-scoped error detection (Kimi Code
 * subscription usage limits) reads it instead of re-deriving the endpoint.
 */
export function detectSdkRequestBaseURL(err: unknown): string | undefined {
  if (!isObject(err)) return undefined;
  const own = (err as { request?: { baseURL?: unknown } }).request;
  return typeof own?.baseURL === 'string' ? own.baseURL : undefined;
}

/**
 * Side channel carrying the credential route a thrown SDK error was sent
 * on. SuperGrok and ChatGPT share `api.x.ai` / `api.openai.com` with the
 * API-key path, so endpoint inspection cannot tell a subscription quota
 * failure from a key rate-limit — the route stamp can.
 */
const requestCredentialRoutes = new WeakMap<object, SdkCredentialRoute>();

/** The credential route recorded for `err`. */
export function detectSdkCredentialRoute(
  err: unknown,
): SdkCredentialRoute | undefined {
  return isObject(err) ? requestCredentialRoutes.get(err) : undefined;
}
