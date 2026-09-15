/**
 * Shared base for a persisted OAuth subscription session (ChatGPT, Grok, …).
 *
 * Every provider's stored bundle carries these four fields identically; the
 * fields that vary (`accountId`, extra claims) are added via `.extend()` on
 * top of this base rather than restated. The schema is the single source of
 * truth for the shape: `SubscriptionSessionBase` is derived from it, and the
 * coordinator's `SubscriptionSession` extends that derived type, so a field
 * added here reaches both without a hand-written mirror to keep in step.
 */
import { z } from 'zod';

export const SubscriptionSessionBaseSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  idToken: z.string().min(1).optional(),
  /** Absolute expiry (ms since epoch). */
  expiresAtMs: z.number(),
});

/** The base shape, derived from {@link SubscriptionSessionBaseSchema}. */
export type SubscriptionSessionBase = z.infer<
  typeof SubscriptionSessionBaseSchema
>;
