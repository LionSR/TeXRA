import { describe, expect, it } from 'vitest';

import {
  backfillFirstRunDone,
  deriveOnboardingFunnelState,
  getDefaultTeamId,
  getFirstRunDone,
  readOnboardingFlags,
  setDefaultTeamId,
  setFirstRunDone,
} from '@controllers/onboarding/onboardingFunnel';
import { GlobalStateKey } from '@shared/state/stateKeys';

import type { StateStore } from '@platform/interfaces/state';

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
  it('marks upgraders with a credential as done', async () => {
    const state = fakeStateStore();
    await backfillFirstRunDone(state, {
      hasCredential: true,
      hasRunHistory: false,
    });
    expect(getFirstRunDone(state)).toBe(true);
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
