/**
 * Schemas + types for the Codex OAuth token bundle.
 *
 * Schema-first per CLAUDE.md: define the Zod schemas, derive the TS types. The
 * stored bundle is the canonical camelCase shape; the raw token-endpoint
 * response is snake_case and transformed at the entry point.
 */
import { z } from 'zod';

import {
  SubscriptionOAuthError,
  type SubscriptionOAuthErrorKind,
} from '../oauth/subscriptionOAuthError';

/** Raw response from the OAuth token endpoint (code exchange + refresh). */
export const CodexTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  // Refresh responses may omit a new refresh_token; the coordinator keeps the
  // previous one in that case.
  refresh_token: z.string().min(1).nullish(),
  id_token: z.string().min(1).nullish(),
  expires_in: z.number(),
});
export type CodexTokenResponse = z.infer<typeof CodexTokenResponseSchema>;

/** The persisted OAuth session bundle (stored as JSON under one secret key). */
export const CodexSessionSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  idToken: z.string().min(1).optional(),
  /** Absolute expiry (ms since epoch). */
  expiresAtMs: z.number(),
  accountId: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
});
export type CodexSession = z.infer<typeof CodexSessionSchema>;

/**
 * How a ChatGPT account is named in user-facing text, from a session, a
 * coordinator status, or the settings wire payload — all of which carry the
 * same optional `email`/`accountId` pair. The email is the identity a user
 * recognizes; the account id is the only other identifier the token carries.
 */
export function codexAccountLabel(
  account:
    | { readonly email?: string | null; readonly accountId?: string | null }
    | null
    | undefined,
): string {
  return account?.email ?? account?.accountId ?? 'your ChatGPT account';
}

/** Device-code "usercode" response. Field name varies (`user_code`/`usercode`). */
export const CodexDeviceUserCodeSchema = z.object({
  device_auth_id: z.string().min(1),
  user_code: z.string().min(1).nullish(),
  usercode: z.string().min(1).nullish(),
  // The endpoint sends the poll interval (seconds) as a string or a number, may
  // omit it, and could send junk. Normalize at the boundary to a positive
  // number, defaulting to 5 (matches Codex CLI / Zed).
  interval: z.coerce.number().positive().catch(5).prefault(5),
  // Lifetime of the user code (seconds), same normalization policy as
  // `interval`. RFC 8628 makes this authoritative when the endpoint sends it;
  // absent or unusable, the caller applies its own fallback deadline.
  expires_in: z.coerce.number().positive().nullish().catch(undefined),
});
export type CodexDeviceUserCode = z.infer<typeof CodexDeviceUserCodeSchema>;

/** Device-code poll success: an authorization code + its PKCE verifier. */
export const CodexDeviceTokenSchema = z.object({
  authorization_code: z.string().min(1),
  code_verifier: z.string().min(1),
  code_challenge: z.string().min(1).nullish(),
});
export type CodexDeviceToken = z.infer<typeof CodexDeviceTokenSchema>;

/** Error kinds match the shared subscription OAuth vocabulary. */
export type CodexAuthErrorKind = SubscriptionOAuthErrorKind;

export class CodexAuthError extends SubscriptionOAuthError {
  constructor(
    message: string,
    kind: CodexAuthErrorKind,
    status?: number,
    options?: ErrorOptions,
  ) {
    super(message, kind, status, options);
    this.name = 'CodexAuthError';
  }
}

/** User-facing message shared by preflight and request-time auth failures. */
export function formatCodexAuthUnavailableMessage(
  error: CodexAuthError,
): string {
  const action = error.needsReauth
    ? 'Sign in with ChatGPT again, or turn off "Prefer ChatGPT subscription".'
    : 'Try again in a moment, or turn off "Prefer ChatGPT subscription".';
  return `ChatGPT subscription unavailable: ${error.message} ${action}`;
}
