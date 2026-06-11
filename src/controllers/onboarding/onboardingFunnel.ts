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
 * sources and reads the flags below from its `platform().globalState`.
 */

import { API_PROVIDERS, apiKeyExists } from '@model/apiProviders';
import { GlobalStateKey } from '@shared/state/stateKeys';

import type { PlatformSecrets } from '@platform/secrets';
import type { StateStore } from '@platform/interfaces/state';

export type OnboardingFunnelState = 'needs-credential' | 'setup' | 'done';

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
  if (inputs.hasCredential) return inputs.firstRunDone ? 'done' : 'setup';
  // A deliberate skip suppresses State 0 on subsequent launches; the user
  // gets the normal product until a credential appears (which re-enters the
  // funnel at State 1 because configuring a credential clears the flag).
  return inputs.declined ? 'done' : 'needs-credential';
}

// ============================================================
// User-scoped flags
// ============================================================

export function getOnboardingDeclined(state: StateStore): boolean {
  return state.get<boolean>(GlobalStateKey.ONBOARDING_DECLINED, false) === true;
}

export async function setOnboardingDeclined(
  state: StateStore,
  declined: boolean,
): Promise<void> {
  await state.update(GlobalStateKey.ONBOARDING_DECLINED, declined);
}

export function getFirstRunDone(state: StateStore): boolean {
  return (
    state.get<boolean>(GlobalStateKey.ONBOARDING_FIRST_RUN_DONE, false) === true
  );
}

export async function setFirstRunDone(
  state: StateStore,
  done: boolean,
): Promise<void> {
  await state.update(GlobalStateKey.ONBOARDING_FIRST_RUN_DONE, done);
}

/** User-level default team id, written by the setup agent's `apply_team`. */
export function getDefaultTeamId(state: StateStore): string | undefined {
  const value = state.get<string>(GlobalStateKey.ONBOARDING_DEFAULT_TEAM_ID);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export async function setDefaultTeamId(
  state: StateStore,
  teamId: string,
): Promise<void> {
  await state.update(GlobalStateKey.ONBOARDING_DEFAULT_TEAM_ID, teamId);
}

export function readOnboardingFlags(
  state: StateStore,
): Pick<OnboardingFunnelInputs, 'declined' | 'firstRunDone'> {
  return {
    declined: getOnboardingDeclined(state),
    firstRunDone: getFirstRunDone(state),
  };
}

/**
 * One-shot migration: upgraders keep their normal product. A user who already
 * has a credential or run history when the flag first appears never sees the
 * welcome card or the setup auto-start. Writes the key on first call (true or
 * false) so the backfill never re-evaluates — a fresh install that gains a
 * credential minutes later must still enter State 1.
 */
export async function backfillFirstRunDone(
  state: StateStore,
  signals: { hasCredential: boolean; hasRunHistory: boolean },
): Promise<void> {
  const existing = state.get<boolean | undefined>(
    GlobalStateKey.ONBOARDING_FIRST_RUN_DONE,
  );
  if (existing !== undefined) return;
  await setFirstRunDone(state, signals.hasCredential || signals.hasRunHistory);
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
    if (await apiKeyExists(secrets, provider)) return true;
  }
  return false;
}
