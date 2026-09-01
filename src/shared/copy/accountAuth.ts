/**
 * Canonical user-facing copy for account sign-in and sign-out surfaces.
 *
 * Account brand names and the outcome sentences that mention them live here so
 * the CLI account & access surfaces, slash-command descriptions, login
 * handlers, the extension's subscription settings section, and the
 * auth-failure hints that quote a toggle by name cannot paraphrase each
 * other. "TeXRA account" itself is owned by `onboarding.ts` — this module
 * imports it rather than restating the name.
 *
 * Wire identifiers (`texra`, `chatgpt`, `grok`) stay internal.
 */

import { RESEARCHER_ACCESS } from './onboarding';

/** Shared device-code option description for any account picker. */
export const DEVICE_CODE_DESCRIPTION =
  'Sign in from SSH or another browser' as const;

/** ChatGPT subscription account — Codex models via Plus/Pro/Team. */
export const CHATGPT_AUTH = {
  label: 'ChatGPT',
  subscriptionLabel: 'ChatGPT subscription',
  signInLabel: 'Sign in with ChatGPT',
  signOutLabel: 'Sign out of ChatGPT',
  preferLabel: 'Prefer ChatGPT subscription',
  deviceCodeLabel: 'ChatGPT device code',
  startingDevice: 'Starting ChatGPT device-code sign-in.',
  startingNoBrowser: 'Starting ChatGPT sign-in.',
  startingBrowser: 'Opening browser for ChatGPT sign-in...',
  signedInEnabled: (accountLabel: string): string =>
    `Signed in with ChatGPT as ${accountLabel} (Codex models enabled).`,
  signedInOverrideDisabled: (accountLabel: string, target: string): string =>
    `Signed in with ChatGPT as ${accountLabel} (Codex models remain disabled because a more specific setting overrides ${target} config).`,
} as const;

/** Grok / xAI subscription account. */
export const GROK_AUTH = {
  label: 'Grok',
  subscriptionLabel: 'Grok subscription',
  signInLabel: 'Sign in with Grok',
  signOutLabel: 'Sign out of Grok',
  preferLabel: 'Prefer Grok subscription',
  deviceCodeLabel: 'Grok device code',
  startingDevice: 'Starting Grok device-code sign-in.',
  startingNoBrowser: 'Starting Grok sign-in.',
  startingBrowser: 'Opening browser for Grok sign-in...',
  signedInEnabled: (accountLabel: string): string =>
    `Signed in with Grok as ${accountLabel} (xAI models enabled).`,
  signedInOverrideDisabled: (accountLabel: string, target: string): string =>
    `Signed in with Grok as ${accountLabel} (xAI models remain disabled because a more specific setting overrides ${target} config).`,
} as const;

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

/**
 * TeXRA account fields that only the account surfaces need. The account
 * name itself stays on {@link RESEARCHER_ACCESS} in `onboarding.ts`.
 */
export const RESEARCHER_ACCESS_AUTH = {
  signInLabel: `Sign in to your ${RESEARCHER_ACCESS.label}`,
  signInExample: `sign in to your ${RESEARCHER_ACCESS.label}`,
  deviceSignInExample: `sign in to your ${RESEARCHER_ACCESS.label} over SSH`,
  credentialsOnlyExample: `sign in to your ${RESEARCHER_ACCESS.label} (credentials only)`,
  loginDescription: `Remote agents through your ${RESEARCHER_ACCESS.label}`,
  deviceCodeLabel: `${RESEARCHER_ACCESS.label} device code`,
  signOutDescription: `Sign out of your ${RESEARCHER_ACCESS.label}`,
  statusDescription: `Show ${RESEARCHER_ACCESS.label} sign-in status`,
  statusExample: `show ${RESEARCHER_ACCESS.label} sign-in status`,
  authDescription: `Sign in with ${CHATGPT_AUTH.label} or ${GROK_AUTH.label}, or sign in to your ${RESEARCHER_ACCESS.label}; check status`,
  /** `/login` slash-command description. */
  slashLoginDescription: `Sign in with ${CHATGPT_AUTH.label} or ${GROK_AUTH.label}, or sign in to your ${RESEARCHER_ACCESS.label}`,
  chatLoginDescription: `manage ${CHATGPT_AUTH.label}, ${GROK_AUTH.label}, and your ${RESEARCHER_ACCESS.label} sign-ins`,
  startingDevice: `Starting device-code sign-in to your ${RESEARCHER_ACCESS.label}.`,
  startingNoBrowser: (provider: string): string =>
    `Starting ${provider} sign-in to your ${RESEARCHER_ACCESS.label}.`,
  startingBrowser: (provider: string): string =>
    `Opening browser for ${provider} sign-in to your ${RESEARCHER_ACCESS.label}...`,
  signedIn: (accountLabel: string): string =>
    `Signed in to your ${RESEARCHER_ACCESS.label} as ${accountLabel}.`,
  signedOut: `Signed out of your ${RESEARCHER_ACCESS.label}.`,
  signOutFailedWithReason: (reason: string): string =>
    ACCOUNT_OUTCOME.signOutFailedWithReason(RESEARCHER_ACCESS.label, reason),
} as const;
