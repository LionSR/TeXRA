/**
 * Shared base for a persisted OAuth subscription session (ChatGPT, Grok, …).
 *
 * Every provider's stored bundle carries these four fields identically; the
 * fields that vary (`accountId`, extra claims) are added via `.extend()` on
 * top of this base rather than restated. Mirrors the `SubscriptionSession`
 * TypeScript interface in `SubscriptionOAuthCoordinator.ts`, which documents
 * the same "extend, don't restate" rule at the type level.
 */
import { z } from 'zod';

export const SubscriptionSessionBaseSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  idToken: z.string().min(1).optional(),
  /** Absolute expiry (ms since epoch). */
  expiresAtMs: z.number(),
});
