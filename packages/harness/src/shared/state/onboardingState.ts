import { Effect } from 'effect';
import { z } from 'zod';
/**
 * User-scoped onboarding state shared by every host.
 *
 * Onboarding is a fact about the user, so these values live in global state
 * rather than workspace state. Funnel transitions and credential checks are
 * owned by the onboarding controllers.
 */

import type { StateStore, StateWriteFailed } from '@platform/interfaces';
import { readState, StateFlagSchema } from '@shared/config/settingsAccess';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { isNonEmptyString } from '@utils/text/stringUtils';

export function setOnboardingDeclined(
  state: StateStore,
  declined: boolean,
): Effect.Effect<void, StateWriteFailed> {
  return state.update(GlobalStateKey.ONBOARDING_DECLINED, declined);
}

export function getFirstRunDone(state: StateStore) {
  return readState(
    state,
    GlobalStateKey.ONBOARDING_FIRST_RUN_DONE,
    StateFlagSchema,
  );
}

export function setFirstRunDone(
  state: StateStore,
  done: boolean,
): Effect.Effect<void, StateWriteFailed> {
  return state.update(GlobalStateKey.ONBOARDING_FIRST_RUN_DONE, done);
}

/** User-level default team id, written by the setup agent's `apply_team`. */
export function getDefaultTeamId(state: StateStore) {
  return Effect.gen(function* () {
    const value = yield* readState(
      state,
      GlobalStateKey.ONBOARDING_DEFAULT_TEAM_ID,
      z.string().optional(),
    );
    return isNonEmptyString(value) ? value : undefined;
  });
}

export function setDefaultTeamId(
  state: StateStore,
  teamId: string,
): Effect.Effect<void, StateWriteFailed> {
  return state.update(GlobalStateKey.ONBOARDING_DEFAULT_TEAM_ID, teamId);
}

/** Drop the user-level default team, restoring the inherited agent list. */
export function clearDefaultTeamId(
  state: StateStore,
): Effect.Effect<void, StateWriteFailed> {
  return state.update(GlobalStateKey.ONBOARDING_DEFAULT_TEAM_ID, undefined);
}

export function readOnboardingFlags(state: StateStore) {
  return Effect.gen(function* () {
    return {
      declined: yield* readState(
        state,
        GlobalStateKey.ONBOARDING_DECLINED,
        StateFlagSchema,
      ),
      firstRunDone: yield* getFirstRunDone(state),
    };
  });
}
