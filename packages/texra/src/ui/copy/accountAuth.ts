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

import type { SUBSCRIPTION_AUTH_PROVIDERS } from '@texra-ai/worldline/schemas';

/** Shared device-code option description for any account picker. */
export const DEVICE_CODE_DESCRIPTION =
  'One-time code; works over SSH or in any browser' as const;

/** ChatGPT subscription account — OpenAI models via Plus/Pro/Team. */
export const CHATGPT_AUTH = Object.freeze({
  label: 'ChatGPT',
  subscriptionLabel: 'ChatGPT subscription',
  signInLabel: 'Sign in with ChatGPT',
  signInDescription: 'Use a ChatGPT subscription',
  /** The row that connects a model through it before any is connected: the
   *  welcome card, the credential banner and the terminal's connect panel. */
  connect: Object.freeze({
    label: 'Use ChatGPT subscription',
    description:
      'OpenAI models through ChatGPT Plus, Pro, or Team; no API key needed',
  }),
  signOutLabel: 'Sign out of ChatGPT',
  deviceCodeLabel: 'Sign in to ChatGPT with a code',
  startingDevice: 'Starting ChatGPT device-code sign-in.',
  startingNoBrowser: 'Starting ChatGPT sign-in.',
  startingBrowser: 'Opening browser for ChatGPT sign-in...',
} as const);

/** Grok / xAI subscription account. */
export const GROK_AUTH = Object.freeze({
  label: 'Grok',
  subscriptionLabel: 'Grok subscription',
  signInLabel: 'Sign in with Grok',
  signInDescription: 'Use a Grok / SuperGrok subscription',
  connect: Object.freeze({
    label: 'Use Grok subscription',
    description: 'Grok models through SuperGrok; no API key needed',
  }),
  signOutLabel: 'Sign out of Grok',
  deviceCodeLabel: 'Sign in to Grok with a code',
  startingDevice: 'Starting Grok device-code sign-in.',
  startingNoBrowser: 'Starting Grok sign-in.',
  startingBrowser: 'Opening browser for Grok sign-in...',
} as const);

/** Each OAuth subscription's copy, keyed by the provider id it belongs to. */
export const SUBSCRIPTION_AUTH_COPY = Object.freeze({
  chatgpt: CHATGPT_AUTH,
  grok: GROK_AUTH,
} as const satisfies Record<
  (typeof SUBSCRIPTION_AUTH_PROVIDERS)[number],
  unknown
>);

/**
 * The two prompts a subscription sign-in shows (`SubscriptionSignInPresenter`),
 * worded once, with their buttons. A host adds only its title and waiting
 * line.
 */
export const SIGN_IN_PROMPT = Object.freeze({
  /** Where to enter the one-time code. `copied`: the host put the code on
   *  the clipboard. */
  deviceCodeSteps: (
    providerDisplayName: string,
    prompt: { readonly verificationUrl: string; readonly userCode: string },
    copied: boolean,
  ): string =>
    `To sign in with ${providerDisplayName}:\n  1. Open ${prompt.verificationUrl}\n  2. Enter the one-time code: ${prompt.userCode}${copied ? ' (copied to the clipboard)' : ''}`,
  /** Beside the loopback sign-in link: the default browser may not be the
   *  one signed in to the account (`sessionName`: 'ChatGPT', 'xAI'). */
  otherBrowser: (sessionName: string): string =>
    `If your ${sessionName} session is in another browser, open the sign-in link there instead.`,
  /** A prompt the host failed to show. */
  presentFailed: (providerDisplayName: string): string =>
    `The ${providerDisplayName} sign-in instructions could not be shown`,
  /** The sign-in link prompt's button that copies the link. */
  copyLinkLabel: 'Copy Sign-in Link',
  /** After the link is copied: where to paste it (`copyTarget`: the
   *  service whose browser session owns the account). */
  linkCopied: (copyTarget: string): string =>
    `Sign-in link copied. Paste it into the browser where you use ${copyTarget}.`,
  /** The one-time-code prompt's button that opens the verification page. */
  openVerificationLabel: 'Open Verification Page',
  /** Why a sign-in asked for a browser callback shows a one-time code. */
  deviceCodeFallback: (providerDisplayName: string): string =>
    `No browser could take the sign-in callback, so ${providerDisplayName} is signing in with a one-time code instead.`,
});

/**
 * Sign-in / sign-out outcome sentences that read the same for any account,
 * parameterized by the provider's display name.
 *
 * All three hosts drive these from the one `subscriptionProvider(id)`
 * descriptor: the CLI auth command and launcher, and the settings body the
 * extension and the desktop share. One outcome of one operation on one
 * account gets one sentence.
 */
export const ACCOUNT_OUTCOME = Object.freeze({
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
  signInFailed: (providerDisplayName: string): string =>
    `${providerDisplayName} sign-in failed`,
  signOutFailed: (providerDisplayName: string): string =>
    `${providerDisplayName} sign-out failed`,
  signOutFailedWithReason: (
    providerDisplayName: string,
    reason: string,
  ): string =>
    `${ACCOUNT_OUTCOME.signOutFailed(providerDisplayName)}: ${reason}`,
} as const);
