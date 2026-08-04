/**
 * Shared error kinds for subscription OAuth coordinators (ChatGPT, Grok, …).
 *
 * - `fatal`     — refresh/grant rejected: session is dead, re-auth required.
 * - `expired`   — no usable session / cannot refresh.
 * - `transient` — 5xx / network blip: keep the session, retry later.
 * - `config`    — misconfiguration (e.g. missing refresh token).
 * - `pending`   — device-code authorization not completed yet.
 */
export type SubscriptionOAuthErrorKind =
  'fatal' | 'expired' | 'transient' | 'config' | 'pending';

export class SubscriptionOAuthError extends Error {
  readonly kind: SubscriptionOAuthErrorKind;
  readonly status?: number;

  constructor(
    message: string,
    kind: SubscriptionOAuthErrorKind,
    status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SubscriptionOAuthError';
    this.kind = kind;
    this.status = status;
  }

  /** Whether the user must re-authenticate (vs. retry). */
  get needsReauth(): boolean {
    return this.kind === 'fatal' || this.kind === 'expired';
  }
}
