/**
 * Canonical user-facing copy for account sign-in and sign-out surfaces.
 *
 * Account brand names and the outcome sentences that mention them live here so
 * the CLI login form, logout form, slash-command descriptions, and login
 * handlers cannot paraphrase each other. "Researcher Access" itself is owned
 * by `onboarding.ts` — this module imports it rather than restating the name.
 *
 * Wire identifiers (`texra`, `chatgpt`, `grok`) stay internal.
 */

import { INCLUDED_ACCESS } from './modelAccess';
import { RESEARCHER_ACCESS } from './onboarding';

/** Shared device-code option description for any account picker. */
export const DEVICE_CODE_DESCRIPTION =
  'Sign in from SSH or another browser' as const;

/** ChatGPT subscription account — Codex models via Plus/Pro/Team. */
export const CHATGPT_AUTH = {
  label: 'ChatGPT',
  subscriptionLabel: 'ChatGPT subscription',
  subscriptionDescription: 'Codex via ChatGPT Plus/Pro/Team',
  deviceCodeLabel: 'ChatGPT device code',
  logoutDescription: 'Sign out and disable subscription preference',
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
  startingDevice: 'Starting Grok device-code sign-in.',
  startingNoBrowser: 'Starting Grok sign-in.',
  startingBrowser: 'Opening browser for Grok sign-in...',
  signedInEnabled: (accountLabel: string): string =>
    `Signed in with Grok as ${accountLabel} (xAI models enabled).`,
  signedInOverrideDisabled: (accountLabel: string, target: string): string =>
    `Signed in with Grok as ${accountLabel} (xAI models remain disabled because a more specific setting overrides ${target} config).`,
} as const;

/**
 * Researcher Access fields that only the account surfaces need. The program
 * name itself stays on {@link RESEARCHER_ACCESS} in `onboarding.ts`.
 */
export const RESEARCHER_ACCESS_AUTH = {
  loginDescription: `${INCLUDED_ACCESS.label} and remote agents`,
  deviceCodeLabel: 'Researcher device code',
  logoutDescription: `Sign out of your ${RESEARCHER_ACCESS.label} account`,
  /** `/login` slash-command description. */
  slashLoginDescription: `Sign in to ${CHATGPT_AUTH.label} or ${RESEARCHER_ACCESS.label}`,
  /** Compact launcher /api action hint. */
  actionHintLogin: `\`texra login\` signs in with ${RESEARCHER_ACCESS.label}`,
  /** Longer launcher action hint when keys are also an option. */
  actionHintLoginOrKey: `choose Model access below, add a provider key, or sign in with ${RESEARCHER_ACCESS.label}`,
  startingDevice: `Starting ${RESEARCHER_ACCESS.label} device-code sign-in.`,
  startingNoBrowser: (provider: string): string =>
    `Starting ${RESEARCHER_ACCESS.label} ${provider} sign-in.`,
  startingBrowser: (provider: string): string =>
    `Opening browser for ${RESEARCHER_ACCESS.label} ${provider} sign-in...`,
  signedIn: (accountLabel: string): string =>
    `Signed in with ${RESEARCHER_ACCESS.label} as ${accountLabel}. Model calls now use ${INCLUDED_ACCESS.inline}.`,
} as const;
