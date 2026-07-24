/**
 * Schemas + types for the Codex OAuth token bundle.
 *
 * Schema-first per CLAUDE.md: define the Zod schemas, derive the TS types. The
 * stored bundle is the canonical camelCase shape; the raw token-endpoint
 * response is snake_case and transformed at the entry point.
 */
import { z } from 'zod';

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

/** Device-code "usercode" response. Field name varies (`user_code`/`usercode`). */
export const CodexDeviceUserCodeSchema = z.object({
  device_auth_id: z.string().min(1),
  user_code: z.string().min(1).nullish(),
  usercode: z.string().min(1).nullish(),
  // The endpoint sends the poll interval (seconds) as a string or a number, may
  // omit it, and could send junk. Normalize at the boundary to a positive
  // number, defaulting to 5 (matches Codex CLI / Zed).
  interval: z.coerce.number().positive().catch(5).prefault(5),
});
export type CodexDeviceUserCode = z.infer<typeof CodexDeviceUserCodeSchema>;

/** Device-code poll success: an authorization code + its PKCE verifier. */
export const CodexDeviceTokenSchema = z.object({
  authorization_code: z.string().min(1),
  code_verifier: z.string().min(1),
  code_challenge: z.string().min(1).nullish(),
});
export type CodexDeviceToken = z.infer<typeof CodexDeviceTokenSchema>;

/**
 * Errors from the Codex auth flow.
 *
 * - `fatal`     — the refresh/grant was rejected (400/401/403): the session is
 *                 dead and the user must sign in again.
 * - `expired`   — there is no usable session / it expired and cannot refresh.
 * - `transient` — a 5xx / network blip: keep the session, retry later.
 * - `config`    — misconfiguration (e.g. account id missing from the JWT).
 * - `pending`   — device-code authorization not completed yet.
 */
export type CodexAuthErrorKind =
  'fatal' | 'expired' | 'transient' | 'config' | 'pending';

export class CodexAuthError extends Error {
  readonly kind: CodexAuthErrorKind;
  readonly status?: number;

  constructor(
    message: string,
    kind: CodexAuthErrorKind,
    status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CodexAuthError';
    this.kind = kind;
    this.status = status;
  }

  /** Whether the user must re-authenticate (vs. retry). */
  get needsReauth(): boolean {
    return this.kind === 'fatal' || this.kind === 'expired';
  }
}

/** User-facing message shared by preflight and request-time auth failures. */
export function formatCodexAuthUnavailableMessage(
  error: CodexAuthError,
): string {
  const action = error.needsReauth
    ? 'A new ChatGPT sign-in or the "ChatGPT subscription preference" switch restores a valid route.'
    : 'The route may recover shortly; the "ChatGPT subscription preference" switch controls whether TeXRA continues using it.';
  return `ChatGPT subscription unavailable: ${error.message} ${action}`;
}
