import { Schema } from 'effect';

/**
 * Shared error kinds for subscription OAuth coordinators (ChatGPT, Grok, …).
 *
 * - `fatal`     — refresh/grant rejected: session is dead, re-auth required.
 * - `expired`   — no usable session / cannot refresh.
 * - `transient` — 5xx / network blip: keep the session, retry later.
 * - `config`    — misconfiguration (e.g. missing refresh token).
 */
export const SubscriptionOAuthErrorKindSchema = Schema.Literals([
  'fatal',
  'expired',
  'transient',
  'config',
]);
/** {@link SubscriptionOAuthErrorKindSchema}'s value. */
export type SubscriptionOAuthErrorKind =
  typeof SubscriptionOAuthErrorKindSchema.Type;

/** A subscription sign-in or refresh failed; `kind` says what to do next. */
export class SubscriptionOAuthError extends Schema.TaggedError<SubscriptionOAuthError>()(
  'SubscriptionOAuthError',
  {
    message: Schema.String,
    kind: SubscriptionOAuthErrorKindSchema,
    status: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  /** Whether the user must re-authenticate (vs. retry). */
  get needsReauth(): boolean {
    return this.kind === 'fatal' || this.kind === 'expired';
  }
}
