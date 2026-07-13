import { describe, expect, it } from 'vitest';

import {
  deriveOnboardingFunnelState,
  planOnboardingFunnelTransition,
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

import type { StateStore } from '@platform/interfaces';

function fakeStateStore(initial: Record<string, unknown> = {}): StateStore {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    get<T>(key: string, defaultValue?: T): T {
      return (store.has(key) ? store.get(key) : defaultValue) as T;
    },
    async update(key: string, value: unknown): Promise<void> {
      store.set(key, value);
    },
  };
}

describe('deriveOnboardingFunnelState', () => {
  it('is needs-credential only without a credential and without a decline', () => {
    expect(
      deriveOnboardingFunnelState({
        hasCredential: false,
        declined: false,
        firstRunDone: false,
      }),
    ).toBe('needs-credential');
  });

  it('a deliberate skip suppresses State 0', () => {
    expect(
      deriveOnboardingFunnelState({
        hasCredential: false,
        declined: true,
        firstRunDone: false,
      }),
    ).toBe('done');
  });

  it('credential present + first run pending → setup owns the session', () => {
    expect(
      deriveOnboardingFunnelState({
        hasCredential: true,
        declined: false,
        firstRunDone: false,
      }),
    ).toBe('setup');
    // A stale declined flag never blocks State 1 once a credential exists.
    expect(
      deriveOnboardingFunnelState({
        hasCredential: true,
        declined: true,
        firstRunDone: false,
      }),
    ).toBe('setup');
  });

  it('a completed first run means the normal product', () => {
    expect(
      deriveOnboardingFunnelState({
        hasCredential: true,
        declined: false,
        firstRunDone: true,
      }),
    ).toBe('done');
    expect(
      deriveOnboardingFunnelState({
        hasCredential: false,
        declined: false,
        firstRunDone: true,
      }),
    ).toBe('done');
  });
});

describe('planOnboardingFunnelTransition', () => {
  it('in-session State 0 → 1: selects the setup agent but never auto-runs', () => {
    expect(
      planOnboardingFunnelTransition('needs-credential', {
        hasCredential: true,
        declined: false,
        firstRunDone: false,
      }),
    ).toEqual({
      state: 'setup',
      selectSetupAgent: true,
      clearDeclined: false,
    });
  });

  it('plain activation in State 1 (previous undefined): selects but never auto-runs', () => {
    expect(
      planOnboardingFunnelTransition(undefined, {
        hasCredential: true,
        declined: false,
        firstRunDone: false,
      }),
    ).toEqual({
      state: 'setup',
      selectSetupAgent: true,
      clearDeclined: false,
    });
  });

  it('a refresh already in State 1 never re-selects (user agent switches survive)', () => {
    expect(
      planOnboardingFunnelTransition('setup', {
        hasCredential: true,
        declined: false,
        firstRunDone: false,
      }),
    ).toEqual({
      state: 'setup',
      selectSetupAgent: false,
      clearDeclined: false,
    });
  });

  it('skipped user who later configures a credential: re-enters State 1, clears the skip, no auto-run', () => {
    expect(
      planOnboardingFunnelTransition('done', {
        hasCredential: true,
        declined: true,
        firstRunDone: false,
      }),
    ).toEqual({
      state: 'setup',
      selectSetupAgent: true,
      clearDeclined: true,
    });
  });

  it('first run already done: credential arrival lands in State 2 with no setup actions', () => {
    expect(
      planOnboardingFunnelTransition('needs-credential', {
        hasCredential: true,
        declined: false,
        firstRunDone: true,
      }),
    ).toEqual({
      state: 'done',
      selectSetupAgent: false,
      clearDeclined: false,
    });
  });

  it('first run already done: missing credentials stay in State 2', () => {
    expect(
      planOnboardingFunnelTransition('needs-credential', {
        hasCredential: false,
        declined: false,
        firstRunDone: true,
      }),
    ).toEqual({
      state: 'done',
      selectSetupAgent: false,
      clearDeclined: false,
    });
  });

  it('State 0 holds while no credential exists', () => {
    expect(
      planOnboardingFunnelTransition('needs-credential', {
        hasCredential: false,
        declined: false,
        firstRunDone: false,
      }),
    ).toEqual({
      state: 'needs-credential',
      selectSetupAgent: false,
      clearDeclined: false,
    });
  });

  it('skip while in State 0: moves to done without setup actions', () => {
    expect(
      planOnboardingFunnelTransition('needs-credential', {
        hasCredential: false,
        declined: true,
        firstRunDone: false,
      }),
    ).toEqual({
      state: 'done',
      selectSetupAgent: false,
      clearDeclined: false,
    });
  });
});

describe('onboarding flags', () => {
  it('round-trips firstRunDone and defaultTeamId through global state', async () => {
    const state = fakeStateStore();
    expect(getFirstRunDone(state)).toBe(false);
    await setFirstRunDone(state, true);
    expect(getFirstRunDone(state)).toBe(true);

    expect(getDefaultTeamId(state)).toBeUndefined();
    await setDefaultTeamId(state, 'physicist');
    expect(getDefaultTeamId(state)).toBe('physicist');
  });

  it('treats a non-string defaultTeamId as unset', () => {
    expect(
      getDefaultTeamId(
        fakeStateStore({ [GlobalStateKey.ONBOARDING_DEFAULT_TEAM_ID]: 7 }),
      ),
    ).toBeUndefined();
    expect(
      getDefaultTeamId(
        fakeStateStore({ [GlobalStateKey.ONBOARDING_DEFAULT_TEAM_ID]: '' }),
      ),
    ).toBeUndefined();
  });

  it('reads both funnel flags in one call', async () => {
    const state = fakeStateStore();
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
  it('marks prior installs with a credential as done', async () => {
    const state = fakeStateStore();
    await backfillFirstRunDone(state, {
      hasCredential: true,
      hasPriorInstall: true,
      hasRunHistory: false,
    });
    expect(getFirstRunDone(state)).toBe(true);
  });

  it('does not mark fresh credential-only installs as done', async () => {
    const state = fakeStateStore();
    await backfillFirstRunDone(state, {
      hasCredential: true,
      hasRunHistory: false,
    });
    expect(getFirstRunDone(state)).toBe(false);
  });

  it('marks upgraders with run history as done', async () => {
    const state = fakeStateStore();
    await backfillFirstRunDone(state, {
      hasCredential: false,
      hasRunHistory: true,
    });
    expect(getFirstRunDone(state)).toBe(true);
  });

  it('writes false for a fresh install so the backfill never re-evaluates', async () => {
    const state = fakeStateStore();
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
    const state = fakeStateStore({
      [GlobalStateKey.ONBOARDING_FIRST_RUN_DONE]: true,
    });
    await backfillFirstRunDone(state, {
      hasCredential: false,
      hasRunHistory: false,
    });
    expect(getFirstRunDone(state)).toBe(true);
  });
});
