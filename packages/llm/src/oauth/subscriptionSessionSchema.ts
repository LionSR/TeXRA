/**
 * Shared base for a persisted OAuth subscription session (ChatGPT, Grok, …).
 *
 * Every provider's stored bundle carries these four fields identically; the
 * fields that vary (`accountId`, extra claims) are added via `.extend()` on
 * top of this base rather than restated. The schema is the single source of
 * truth for the shape: the coordinator's `SubscriptionSession` is derived
 * from it, so a field added here reaches it without a hand-written mirror to
 * keep in step. The same goes for the token-endpoint response the sign-in
 * flows decode.
 */
import { Schema } from 'effect';

/** The fields every provider's stored session carries. */
export const SubscriptionSessionBaseSchema = Schema.Struct({
  accessToken: Schema.NonEmptyString,
  refreshToken: Schema.NonEmptyString,
  idToken: Schema.optional(Schema.NonEmptyString),
  /** Absolute expiry (ms since epoch). */
  expiresAtMs: Schema.Number,
});

/**
 * Raw token-endpoint response shared by the authorization-code and refresh
 * grants. Refresh responses may omit a new `refresh_token`; the coordinator
 * keeps the previous one in that case.
 */
export const SubscriptionTokenResponseSchema = Schema.Struct({
  access_token: Schema.NonEmptyString,
  refresh_token: Schema.optional(Schema.NullOr(Schema.NonEmptyString)),
  id_token: Schema.optional(Schema.NullOr(Schema.NonEmptyString)),
  expires_in: Schema.Number,
});
