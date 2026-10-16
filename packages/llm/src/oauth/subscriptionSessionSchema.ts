/**
 * Shared base for a persisted OAuth subscription session (ChatGPT, Grok, …).
 *
 * Every provider's stored bundle carries these four fields identically; the
 * fields that vary (`accountId`, extra claims) are added via `.extend()` on
 * top of this base rather than restated. The schema is the single source of
 * truth for the shape: the coordinator's `SubscriptionSession` is derived
 * from it, so a field added here reaches it without a hand-written mirror to
 * keep in step.
 */
import { z } from 'zod';

/** The fields every provider's stored session carries. */
export const SubscriptionSessionBaseSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  idToken: z.string().min(1).optional(),
  /** Absolute expiry (ms since epoch). */
  expiresAtMs: z.number(),
});
