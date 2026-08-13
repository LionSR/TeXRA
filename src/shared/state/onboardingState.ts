/**
 * User-scoped onboarding state shared by every host.
 *
 * Onboarding is a fact about the user, so these values live in global state
 * rather than workspace state. Funnel transitions and credential checks are
 * owned by the onboarding controllers.
 */

import type { StateStore } from '@platform/interfaces';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { isNonEmptyString } from '@utils/core';

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
  return isNonEmptyString(value) ? value : undefined;
}

export async function setDefaultTeamId(
  state: StateStore,
  teamId: string,
): Promise<void> {
  await state.update(GlobalStateKey.ONBOARDING_DEFAULT_TEAM_ID, teamId);
}

export function readOnboardingFlags(state: StateStore): {
  /** The user saw the credential picker and chose "Skip for now". */
  declined: boolean;
  /** A run has completed or the setup agent handed off. */
  firstRunDone: boolean;
} {
  return {
    declined:
      state.get<boolean>(GlobalStateKey.ONBOARDING_DECLINED, false) === true,
    firstRunDone: getFirstRunDone(state),
  };
}

/**
 * One-shot migration: upgraders keep their normal product. A prior install
 * with a credential, or any install with run history, never sees first-run
 * onboarding. The key is written on the first call, even when the value is
 * false, so the backfill never re-evaluates.
 */
export async function backfillFirstRunDone(
  state: StateStore,
  signals: {
    hasCredential: boolean;
    hasPriorInstall?: boolean;
    hasRunHistory: boolean;
  },
): Promise<void> {
  const existing = state.get<boolean | undefined>(
    GlobalStateKey.ONBOARDING_FIRST_RUN_DONE,
  );
  if (existing !== undefined) return;
  await setFirstRunDone(
    state,
    signals.hasRunHistory ||
      (signals.hasPriorInstall === true && signals.hasCredential),
  );
}
