/**
 * Canonical user-facing copy for account sign-in and sign-out surfaces.
 *
 * Account brand names and the outcome sentences that mention them live here so
 * the CLI account & access surfaces, slash-command descriptions, login
 * handlers and the extension's subscription settings section cannot
 * paraphrase each other. Each subscription's switch and sign-in names are the
 * harness's (`SUBSCRIPTION_AUTH_NAMES`), which its auth-failure hints quote,
 * so this copy repeats them rather than restating them.
 *
 * Wire identifiers (`chatgpt`, `grok`) stay internal.
 */

import {
  SUBSCRIPTION_AUTH_NAMES,
  type SUBSCRIPTION_AUTH_PROVIDERS,
} from '@texra-ai/harness/schemas';

/** Shared device-code option description for any account picker. */
export const DEVICE_CODE_DESCRIPTION =
  'One-time code; works over SSH or in any browser' as const;

/** ChatGPT subscription account — Codex models via Plus/Pro/Team. */
export const CHATGPT_AUTH = {
  label: 'ChatGPT',
  ...SUBSCRIPTION_AUTH_NAMES.chatgpt,
  signInDescription: 'Use a ChatGPT subscription',
  signOutLabel: 'Sign out of ChatGPT',
  deviceCodeLabel: 'Sign in to ChatGPT with a code',
  startingDevice: 'Starting ChatGPT device-code sign-in.',
  startingNoBrowser: 'Starting ChatGPT sign-in.',
  startingBrowser: 'Opening browser for ChatGPT sign-in...',
  signedInEnabled: (accountLabel: string): string =>
    `Signed in with ChatGPT as ${accountLabel} (Codex models enabled).`,
} as const;

/** Grok / xAI subscription account. */
export const GROK_AUTH = {
  label: 'Grok',
  ...SUBSCRIPTION_AUTH_NAMES.grok,
  signInDescription: 'Use a Grok / SuperGrok subscription',
  signOutLabel: 'Sign out of Grok',
  deviceCodeLabel: 'Sign in to Grok with a code',
  startingDevice: 'Starting Grok device-code sign-in.',
  startingNoBrowser: 'Starting Grok sign-in.',
  startingBrowser: 'Opening browser for Grok sign-in...',
  signedInEnabled: (accountLabel: string): string =>
    `Signed in with Grok as ${accountLabel} (xAI models enabled).`,
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
 * descriptor and reported the outcome in their own words: the CLI auth command
 * and launcher, the desktop credential controller, and the extension's
 * settings handlers. One outcome of one operation on one account gets one
 * sentence.
 */
export const ACCOUNT_OUTCOME = {
  signedInAs: (providerDisplayName: string, accountLabel: string): string =>
    `Signed in with ${providerDisplayName} as ${accountLabel}.`,
  signedOut: (providerDisplayName: string): string =>
    `Signed out of ${providerDisplayName}.`,
  /** Prefix only — the extension appends the reason through its own logger. */
  signOutFailed: (providerDisplayName: string): string =>
    `${providerDisplayName} sign-out failed`,
  signOutFailedWithReason: (
    providerDisplayName: string,
    reason: string,
  ): string =>
    `${ACCOUNT_OUTCOME.signOutFailed(providerDisplayName)}: ${reason}`,
} as const;
