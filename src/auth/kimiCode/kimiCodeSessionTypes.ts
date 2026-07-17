/**
 * Schemas + types for the Kimi Code OAuth token bundle.
 *
 * Schema-first per AGENTS.md: define the Zod schemas, derive the TS types. The
 * stored bundle is the canonical camelCase shape; the raw token-endpoint
 * response is snake_case and transformed at the entry point.
 */
import { z } from 'zod';

/** Raw response from the OAuth token endpoint (device-code exchange + refresh). */
export const KimiCodeTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  // Refresh responses may omit a new refresh_token; the coordinator keeps the
  // previous one in that case.
  refresh_token: z.string().min(1).nullish(),
  expires_in: z.number(),
  scope: z.string().nullish(),
  token_type: z.string().nullish(),
});
export type KimiCodeTokenResponse = z.infer<typeof KimiCodeTokenResponseSchema>;

/** The persisted OAuth session bundle (stored as JSON under one secret key). */
export const KimiCodeSessionSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  /** Absolute expiry (ms since epoch). */
  expiresAtMs: z.number(),
  accountId: z.string().min(1).optional(),
});
export type KimiCodeSession = z.infer<typeof KimiCodeSessionSchema>;

/** Device-code "usercode" response. */
export const KimiCodeDeviceUserCodeSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().min(1).nullish(),
  verification_uri_complete: z.string().min(1).nullish(),
  expires_in: z.number().nullish(),
  // The endpoint sends the poll interval (seconds) as a string or a number, may
  // omit it, and could send junk. Normalize at the boundary to a positive
  // number, defaulting to 5.
  interval: z.coerce.number().positive().catch(5).prefault(5),
});
export type KimiCodeDeviceUserCode = z.infer<
  typeof KimiCodeDeviceUserCodeSchema
>;

/**
 * Errors from the Kimi Code auth flow.
 *
 * - `fatal`     — the refresh/grant was rejected (400/401/403): the session is
 *                 dead and the user must sign in again.
 * - `expired`   — there is no usable session / it expired and cannot refresh.
 * - `transient` — a 5xx / network blip: keep the session, retry later.
 * - `pending`   — device-code authorization not completed yet.
 */
export type KimiCodeAuthErrorKind = 'fatal' | 'expired' | 'transient' | 'pending';

export class KimiCodeAuthError extends Error {
  readonly kind: KimiCodeAuthErrorKind;
  readonly status?: number;

  constructor(
    message: string,
    kind: KimiCodeAuthErrorKind,
    status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'KimiCodeAuthError';
    this.kind = kind;
    this.status = status;
  }

  /** Whether the user must re-authenticate (vs. retry). */
  get needsReauth(): boolean {
    return this.kind === 'fatal' || this.kind === 'expired';
  }
}

/** User-facing message shared by preflight and request-time auth failures. */
export function formatKimiCodeAuthUnavailableMessage(
  error: KimiCodeAuthError,
): string {
  const action = error.needsReauth
    ? 'Sign in with Kimi Code again, or turn off "Prefer Kimi Code subscription".'
    : 'Try again in a moment, or turn off "Prefer Kimi Code subscription".';
  return `Kimi Code subscription unavailable: ${error.message} ${action}`;
}
