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

import type { OnboardingFunnelState } from '@shared/schemas';

export type { OnboardingFunnelState };

export interface OnboardingFunnelInputs {
  /** A usable credential exists (a subscription or any provider API key). */
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
