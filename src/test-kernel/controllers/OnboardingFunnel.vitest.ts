import { describe, expect, it } from 'vitest';

import {
  deriveOnboardingFunnelState,
  planOnboardingFunnelTransition,
  type OnboardingFunnelInputs,
  type OnboardingFunnelTransition,
} from '@controllers/onboarding/onboardingFunnel';
import type { OnboardingFunnelState } from '@shared/schemas';
import { getDefaultTeamId } from '@shared/state/onboardingState';
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
});
