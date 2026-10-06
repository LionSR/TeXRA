/**
 * Schemas + types for the Codex OAuth token bundle.
 *
 * Schema-first per CLAUDE.md: define the Zod schemas, derive the TS types. The
 * stored bundle is the canonical camelCase shape; the raw token-endpoint
 * response is snake_case and transformed at the entry point.
 */
import { z } from 'zod';

import { SubscriptionSessionBaseSchema } from '../subscriptionSessionSchema.js';

/** Raw response from the OAuth token endpoint (code exchange + refresh). */
export const CodexTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  // Refresh responses may omit a new refresh_token; the coordinator keeps the
  // previous one in that case.
  refresh_token: z.string().min(1).nullish(),
  id_token: z.string().min(1).nullish(),
  expires_in: z.number(),
});

/** The persisted OAuth session bundle (stored as JSON under one secret key). */
export const CodexSessionSchema = SubscriptionSessionBaseSchema.extend({
  accountId: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
  /** The ChatGPT plan the token was issued for (`plus`, `pro`, `team`, ...). */
  planType: z.string().min(1).optional(),
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
  // Lifetime of the user code (seconds), same normalization policy as
  // `interval`. RFC 8628 makes this authoritative when the endpoint sends it;
  // absent or unusable, the caller applies its own fallback deadline.
  expires_in: z.coerce.number().positive().nullish().catch(undefined),
});

/** Device-code poll success: an authorization code + its PKCE verifier. */
export const CodexDeviceTokenSchema = z.object({
  authorization_code: z.string().min(1),
  code_verifier: z.string().min(1),
  code_challenge: z.string().min(1).nullish(),
});
