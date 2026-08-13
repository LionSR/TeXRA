import { describe, expect, it } from 'vitest';

import {
  deriveOnboardingFunnelState,
  planOnboardingFunnelTransition,
  type OnboardingFunnelInputs,
  type OnboardingFunnelState,
  type OnboardingFunnelTransition,
} from '@controllers/onboarding/onboardingFunnel';
import {
  backfillFirstRunDone,
  getDefaultTeamId,
  getFirstRunDone,
  readOnboardingFlags,
  setDefaultTeamId,
  setFirstRunDone,
} from '@shared/state/onboardingState';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { FakeStateStore } from '@test/support/FakePlatform';

describe('deriveOnboardingFunnelState', () => {
  it.each<[string, OnboardingFunnelInputs, OnboardingFunnelState]>([
    [
      'is needs-credential only without a credential and without a decline',
      { hasCredential: false, declined: false, firstRunDone: false },
      'needs-credential',
    ],
    [
      'a deliberate skip suppresses State 0',
      { hasCredential: false, declined: true, firstRunDone: false },
      'done',
    ],
    [
      'credential present + first run pending → setup owns the session',
      { hasCredential: true, declined: false, firstRunDone: false },
      'setup',
    ],
    [
      'a stale declined flag never blocks State 1 once a credential exists',
      { hasCredential: true, declined: true, firstRunDone: false },
      'setup',
    ],
    [
      'a completed first run with a credential means the normal product',
      { hasCredential: true, declined: false, firstRunDone: true },
      'done',
    ],
    [
      'a completed first run without a credential means the normal product',
      { hasCredential: false, declined: false, firstRunDone: true },
      'done',
    ],
  ])('%s', (_name, inputs, expected) => {
    expect(deriveOnboardingFunnelState(inputs)).toBe(expected);
  });
});

describe('planOnboardingFunnelTransition', () => {
  it.each<
    [
      string,
      OnboardingFunnelState | undefined,
      OnboardingFunnelInputs,
      OnboardingFunnelTransition,
    ]
  >([
    [
      'in-session State 0 → 1: selects the setup agent but never auto-runs',
      'needs-credential',
      { hasCredential: true, declined: false, firstRunDone: false },
      { state: 'setup', selectSetupAgent: true, clearDeclined: false },
    ],
    [
      'plain activation in State 1 (previous undefined): selects but never auto-runs',
      undefined,
      { hasCredential: true, declined: false, firstRunDone: false },
      { state: 'setup', selectSetupAgent: true, clearDeclined: false },
    ],
    [
      'a refresh already in State 1 never re-selects (user agent switches survive)',
      'setup',
      { hasCredential: true, declined: false, firstRunDone: false },
      { state: 'setup', selectSetupAgent: false, clearDeclined: false },
    ],
    [
      'skipped user who later configures a credential: re-enters State 1, clears the skip, no auto-run',
      'done',
      { hasCredential: true, declined: true, firstRunDone: false },
      { state: 'setup', selectSetupAgent: true, clearDeclined: true },
    ],
    [
      'first run already done: credential arrival lands in State 2 with no setup actions',
      'needs-credential',
      { hasCredential: true, declined: false, firstRunDone: true },
      { state: 'done', selectSetupAgent: false, clearDeclined: false },
    ],
    [
      'first run already done: missing credentials stay in State 2',
      'needs-credential',
      { hasCredential: false, declined: false, firstRunDone: true },
      { state: 'done', selectSetupAgent: false, clearDeclined: false },
    ],
    [
      'State 0 holds while no credential exists',
      'needs-credential',
      { hasCredential: false, declined: false, firstRunDone: false },
      {
        state: 'needs-credential',
        selectSetupAgent: false,
        clearDeclined: false,
      },
    ],
    [
      'skip while in State 0: moves to done without setup actions',
      'needs-credential',
      { hasCredential: false, declined: true, firstRunDone: false },
      { state: 'done', selectSetupAgent: false, clearDeclined: false },
    ],
  ])('%s', (_name, previous, inputs, expected) => {
    expect(planOnboardingFunnelTransition(previous, inputs)).toEqual(expected);
  });
});

describe('onboarding flags', () => {
  it('round-trips firstRunDone and defaultTeamId through global state', async () => {
    const state = new FakeStateStore();
    expect(getFirstRunDone(state)).toBe(false);
    await setFirstRunDone(state, true);
    expect(getFirstRunDone(state)).toBe(true);

    expect(getDefaultTeamId(state)).toBeUndefined();
    await setDefaultTeamId(state, 'physicist');
    expect(getDefaultTeamId(state)).toBe('physicist');
  });

  it.each([7, ''])(
    'treats a non-team-id defaultTeamId %j as unset',
    (value) => {
      expect(
        getDefaultTeamId(
          new FakeStateStore({
            [GlobalStateKey.ONBOARDING_DEFAULT_TEAM_ID]: value,
          }),
        ),
      ).toBeUndefined();
    },
  );

  it('reads both funnel flags in one call', async () => {
    const state = new FakeStateStore();
    expect(readOnboardingFlags(state)).toEqual({
      declined: false,
      firstRunDone: false,
    });
    await state.update(GlobalStateKey.ONBOARDING_DECLINED, true);
    await setFirstRunDone(state, true);
    expect(readOnboardingFlags(state)).toEqual({
      declined: true,
      firstRunDone: true,
    });
  });
});

describe('backfillFirstRunDone', () => {
  it.each<[string, Parameters<typeof backfillFirstRunDone>[1], boolean]>([
    [
      'marks prior installs with a credential as done',
      { hasCredential: true, hasPriorInstall: true, hasRunHistory: false },
      true,
    ],
    [
      'does not mark fresh credential-only installs as done',
      { hasCredential: true, hasRunHistory: false },
      false,
    ],
    [
      'marks upgraders with run history as done',
      { hasCredential: false, hasRunHistory: true },
      true,
    ],
  ])('%s', async (_name, signals, expected) => {
    const state = new FakeStateStore();
    await backfillFirstRunDone(state, signals);
    expect(getFirstRunDone(state)).toBe(expected);
  });

  it('writes false for a fresh install so the backfill never re-evaluates', async () => {
    const state = new FakeStateStore();
    await backfillFirstRunDone(state, {
      hasCredential: false,
      hasRunHistory: false,
    });
    expect(state.get(GlobalStateKey.ONBOARDING_FIRST_RUN_DONE)).toBe(false);

    // A later credential must not flip the backfilled value: a fresh install
    // that signs in minutes after activation still enters State 1.
    await backfillFirstRunDone(state, {
      hasCredential: true,
      hasRunHistory: false,
    });
    expect(getFirstRunDone(state)).toBe(false);
  });

  it('never overwrites an existing flag', async () => {
    const state = new FakeStateStore({
      [GlobalStateKey.ONBOARDING_FIRST_RUN_DONE]: true,
    });
    await backfillFirstRunDone(state, {
      hasCredential: false,
      hasRunHistory: false,
    });
    expect(getFirstRunDone(state)).toBe(true);
  });
});
