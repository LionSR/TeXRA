/**
 * The record a host keeps while one OAuth sign-in attempt is outstanding.
 *
 * It is the login-CSRF guard: an inbound callback is only allowed to complete
 * the attempt whose nonce it carries, so the shape that check reads is one
 * schema rather than a per-host object literal. The nonce is the 32-hex string
 * both hosts mint from `randomBytes(16)`; validating it here means a stored
 * record that does not look like one of ours is rejected at the boundary
 * instead of being compared against a live attempt.
 */

import { z } from 'zod';

import { AUTH_CALLBACK_TIMEOUT_MS } from './config';

/** A sign-in nonce: `randomBytes(16).toString('hex')`. */
export const OAUTH_NONCE_PATTERN = /^[0-9a-f]{32}$/;

/** A Supabase PKCE flow id, as the client mints it. */
export const PKCE_FLOW_ID_PATTERN = /^[a-zA-Z0-9_-]{8,64}$/;

export const PendingOAuthStateSchema = z.strictObject({
  /** Binds an inbound callback to the attempt this client started. */
  nonce: z.string().regex(OAUTH_NONCE_PATTERN),
  createdAt: z.number().finite(),
  /** The PKCE flow the attempt bound, on hosts that complete the exchange
   *  themselves. Absent while the attempt is only awaiting its callback. */
  flowId: z.string().regex(PKCE_FLOW_ID_PATTERN).optional(),
});
export type PendingOAuthState = z.infer<typeof PendingOAuthStateSchema>;

/**
 * A pending attempt is still answerable: it was created no longer than the
 * callback timeout ago, and not in the future — a record stamped ahead of the
 * clock is a record this process cannot reason about, so it is spent rather
 * than trusted for the length of the skew.
 */
export function isPendingOAuthStateFresh(
  state: Pick<PendingOAuthState, 'createdAt'>,
): boolean {
  const age = Date.now() - state.createdAt;
  return age >= 0 && age <= AUTH_CALLBACK_TIMEOUT_MS;
}
