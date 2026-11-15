/**
 * Canonical user-facing copy for account sign-in and sign-out surfaces.
 *
 * Account brand names and the outcome sentences that mention them live here so
 * the CLI account & access surfaces, slash-command descriptions, login
 * handlers and the extension's subscription settings section cannot
 * paraphrase each other.
 *
 * The switch that routes eligible models through a subscription is named by
 * the subscription itself (`subscriptionLabel`, "ChatGPT subscription") and
 * never by a verb. It selects a credential rather than expressing a
 * preference among them: a session that cannot be read fails the run and
 * asks the user to sign in again, so a "Prefer …" label would promise a
 * fallback to the API key that routing does not perform. One noun also keeps
 * the switch recognizable in the row that toggles it and in the messages
 * that quote it back (a used-up plan's, `@ui/copy/modelAccess`).
 *
 * Wire identifiers (`chatgpt`, `grok`) stay internal.
 */

import type { SUBSCRIPTION_AUTH_PROVIDERS } from '@texra-ai/harness/schemas';

/** Shared device-code option description for any account picker. */
export const DEVICE_CODE_DESCRIPTION =
  'One-time code; works over SSH or in any browser' as const;

/** ChatGPT subscription account — OpenAI models via Plus/Pro/Team. */
export const CHATGPT_AUTH = {
  label: 'ChatGPT',
  subscriptionLabel: 'ChatGPT subscription',
  signInLabel: 'Sign in with ChatGPT',
  signInDescription: 'Use a ChatGPT subscription',
  signOutLabel: 'Sign out of ChatGPT',
  deviceCodeLabel: 'Sign in to ChatGPT with a code',
  startingDevice: 'Starting ChatGPT device-code sign-in.',
  startingNoBrowser: 'Starting ChatGPT sign-in.',
  startingBrowser: 'Opening browser for ChatGPT sign-in...',
} as const;

/** Grok / xAI subscription account. */
export const GROK_AUTH = {
  label: 'Grok',
  subscriptionLabel: 'Grok subscription',
  signInLabel: 'Sign in with Grok',
  signInDescription: 'Use a Grok / SuperGrok subscription',
  signOutLabel: 'Sign out of Grok',
  deviceCodeLabel: 'Sign in to Grok with a code',
  startingDevice: 'Starting Grok device-code sign-in.',
  startingNoBrowser: 'Starting Grok sign-in.',
  startingBrowser: 'Opening browser for Grok sign-in...',
} as const;

/** Each OAuth subscription's copy, keyed by the provider id it belongs to. */
export const SUBSCRIPTION_AUTH_COPY = {
  chatgpt: CHATGPT_AUTH,
  grok: GROK_AUTH,
} as const satisfies Record<
  (typeof SUBSCRIPTION_AUTH_PROVIDERS)[number],
  unknown
>;

/**
 * Sign-in / sign-out outcome sentences that read the same for any account,
 * parameterized by the provider's display name.
 *
 * All three hosts drive these from the one `subscriptionProvider(id)`
 * descriptor: the CLI auth command and launcher, and the settings body the
 * extension and the desktop share. One outcome of one operation on one
 * account gets one sentence.
 */
export const ACCOUNT_OUTCOME = {
  signedInAs: (providerDisplayName: string, accountLabel: string): string =>
    `Signed in with ${providerDisplayName} as ${accountLabel}.`,
  /** What a finished sign-in reports: it also turned the subscription on
   *  for `modelFamily` (the provider's 'OpenAI models', 'xAI models'). */
  signedInEnabled: (
    providerDisplayName: string,
    accountLabel: string,
    modelFamily: string,
  ): string =>
    `Signed in with ${providerDisplayName} as ${accountLabel} (${modelFamily} enabled).`,
  /** A sign-out that could not turn the subscription off afterwards. */
  subscriptionNotDisabled: (
    providerDisplayName: string,
    reason: string,
  ): string =>
    `${providerDisplayName} subscription could not be disabled: ${reason}`,
  signedOut: (providerDisplayName: string): string =>
    `Signed out of ${providerDisplayName}.`,
  notSignedIn: (providerDisplayName: string): string =>
    `Not signed in with ${providerDisplayName}.`,
  /** Prefix only — the extension appends the reason through its own logger. */
  signOutFailed: (providerDisplayName: string): string =>
    `${providerDisplayName} sign-out failed`,
  signOutFailedWithReason: (
    providerDisplayName: string,
    reason: string,
  ): string =>
    `${ACCOUNT_OUTCOME.signOutFailed(providerDisplayName)}: ${reason}`,
} as const;
