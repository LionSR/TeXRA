/**
 * Host-neutral onboarding funnel (PRD: agent-native onboarding).
 *
 * The funnel state is derived, never a mode the user (or code) sets:
 *
 *   0 — needs-credential  no usable credential, not previously declined
 *   1 — setup             credential present, first run not yet completed
 *   2 — done              a run has completed (or the user opted out)
 *
 * All inputs are user-scoped (global state / secrets), never
 * workspace-scoped: onboarding is a fact about the user, and a fresh
 * workspace must never demote a veteran back to State 0/1. Each host
 * (extension, CLI, desktop) computes `hasCredential` with its own credential
 * sources and reads the flags from `@shared/state/onboardingState` using its
 * `platform().globalState`.
 */

import { getServerSideKeyService } from '@auth/serverKeys';
import { API_PROVIDERS, lookupApiKey } from '@model/apiProviders';
import { isCodexSubscriptionActive } from '@model/codexSubscriptionActive';
import { CHATGPT_SETUP_MODEL } from '@model/setupModelDefaults';
import type { OnboardingFunnelState } from '@shared/schemas/onboarding';
import { isNonEmptyString } from '@utils/core';
import type { PlatformSecrets } from '@platform/secrets';

export type { OnboardingFunnelState };

export interface OnboardingFunnelInputs {
  /** A usable credential exists (relay sign-in or any provider API key). */
  hasCredential: boolean;
  /** The user saw the State 0 picker and chose "Skip for now". */
  declined: boolean;
  /** A run has completed (or the setup agent handed off). */
  firstRunDone: boolean;
}

export function deriveOnboardingFunnelState(
  inputs: OnboardingFunnelInputs,
): OnboardingFunnelState {
  if (inputs.firstRunDone) return 'done';
  if (inputs.hasCredential) return 'setup';
  // A deliberate skip suppresses State 0 on subsequent launches; the user
  // gets the normal product until a credential appears (which re-enters the
  // funnel at State 1 because configuring a credential clears the flag).
  return inputs.declined ? 'done' : 'needs-credential';
}

/** What a host should do after recomputing the funnel. */
export interface OnboardingFunnelTransition {
  /** The newly derived funnel state (push to the webview). */
  state: OnboardingFunnelState;
  /** Select the setup agent in the launcher (entering State 1). */
  selectSetupAgent: boolean;
  /** Configuring a credential clears a previous skip (PRD edge case). */
  clearDeclined: boolean;
}

/**
 * Pure transition planner for hosts that recompute the funnel in-session
 * (webview ready, credential-changed events, skip). `previous` is the state
 * from the host's last computation, or `undefined` on the first one.
 *
 * Entering State 1 only *selects* the setup agent and shows the setup card; it
 * never auto-starts the setup conversation. The setup agent runs an
 * environment probe that may install tools, so launching it is an explicit,
 * consented action — the user clicks "Run setup assistant" on the setup card
 * (or invokes the command) to start it. There is deliberately no auto-kickoff.
 */
export function planOnboardingFunnelTransition(
  previous: OnboardingFunnelState | undefined,
  inputs: OnboardingFunnelInputs,
): OnboardingFunnelTransition {
  const state = deriveOnboardingFunnelState(inputs);
  return {
    state,
    // Entering State 1 (from ready, State 0, or a declined "done") selects
    // the setup agent; a refresh already in State 1 must not stomp a user
    // who deliberately switched agents mid-session.
    selectSetupAgent: state === 'setup' && previous !== 'setup',
    clearDeclined: inputs.declined && inputs.hasCredential,
  };
}

// ============================================================
// Credential presence (shared building block)
// ============================================================

/**
 * True when any provider has a usable API key (secret or env var). Relay
 * sign-in checks stay host-specific; hosts OR this with their own check.
 */
export async function hasAnyProviderApiKey(
  secrets: PlatformSecrets,
): Promise<boolean> {
  for (const provider of API_PROVIDERS) {
    // Sequential by design: stop at the first key found.
    const key = await lookupApiKey(secrets, provider);
    if (isNonEmptyString(key)) return true;
  }
  return false;
}

/**
 * Single source of truth for "does the user have a usable credential to
 * proceed with setup": an active ChatGPT (Codex) subscription, a non-blank
 * provider API key, or relay access to server-side keys. Provider keys are
 * checked before `canUseServerSideKeys()` deliberately: the latter is a
 * network round-trip that can prime the relay-quota cache and trigger a
 * quota auto-switch, so a cheap local key that already satisfies the gate
 * should short-circuit before that side effect fires.
 *
 * Extension and desktop call this directly, so neither can drift from the
 * other on what counts as "usable" or in what order. The CLI's credential
 * gate (`packages/cli/src/runtime/credentialStatus.ts`) does not call this
 * predicate — it needs an `apiMode`-aware policy (included-relay vs.
 * personal-key sign-in must each unlock their own mode) — but it composes
 * the same underlying primitives (`hasAnyProviderApiKey`,
 * `isCodexSubscriptionActive`) so the individual checks stay consistent even
 * though the CLI's combination policy differs.
 */
export async function hasUsableSetupCredential(
  secrets: PlatformSecrets,
): Promise<boolean> {
  if (await isCodexSubscriptionActive(CHATGPT_SETUP_MODEL)) return true;
  if (await hasAnyProviderApiKey(secrets)) return true;
  return getServerSideKeyService().canUseServerSideKeys();
}
