import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect, vi } from 'vitest';

import { preflightTeamAvailability } from '@common/teams/TeamAvailabilityPreflight';

interface Resolution {
  readonly unresolvedNames: readonly string[];
}

const hosted = new Set(['orchestrator']);

function options(overrides: {
  initial?: Resolution;
  authenticated?: boolean;
  choice?: 'sign-in' | 'continue' | 'cancel';
  providedChoice?: 'sign-in' | 'continue' | 'cancel';
  choiceRequired?: boolean;
  signedIn?: boolean;
  refreshed?: Resolution;
  remoteCatalogRefreshAttempted?: boolean;
}) {
  const refresh = vi.fn(() => undefined);
  const signIn = vi.fn(async () => overrides.signedIn ?? true);
  const choose = vi.fn(async () =>
    overrides.choiceRequired ? undefined : (overrides.choice ?? 'cancel'),
  );
  return {
    refresh,
    signIn,
    choose,
    input: {
      initial: overrides.initial ?? { unresolvedNames: ['orchestrator'] },
      unresolvedNames: (value: Resolution) => value.unresolvedNames,
      texraHostedNames: hosted,
      canAccessRemoteCatalog: async () => overrides.authenticated ?? false,
      providedChoice: overrides.providedChoice,
      choose,
      signIn,
      refreshRemote: () =>
        Effect.sync(() => {
          refresh();
        }),
      replan: () => overrides.refreshed ?? { unresolvedNames: [] },
      remoteCatalogRefreshAttempted: overrides.remoteCatalogRefreshAttempted,
    },
  };
}

describe('team availability preflight', () => {
  it.effect('does not prompt or refresh a local-only team', () =>
    Effect.gen(function* () {
      const deps = options({ initial: { unresolvedNames: ['local-plugin'] } });
      expect(yield* preflightTeamAvailability(deps.input)).toEqual({
        status: 'proceed',
        value: { unresolvedNames: ['local-plugin'] },
        partial: false,
      });
      expect(deps.choose).not.toHaveBeenCalled();
      expect(deps.refresh).not.toHaveBeenCalled();
    }),
  );

  it.effect('continues only after an explicit partial-team choice', () =>
    Effect.gen(function* () {
      const deps = options({ choice: 'continue' });
      expect(yield* preflightTeamAvailability(deps.input)).toMatchObject({
        status: 'proceed',
        partial: true,
      });
      expect(deps.signIn).not.toHaveBeenCalled();
      expect(deps.refresh).not.toHaveBeenCalled();
    }),
  );

  it.effect('cancels without signing in or refreshing', () =>
    Effect.gen(function* () {
      const deps = options({ choice: 'cancel' });
      expect(yield* preflightTeamAvailability(deps.input)).toMatchObject({
        status: 'cancelled',
      });
      expect(deps.signIn).not.toHaveBeenCalled();
      expect(deps.refresh).not.toHaveBeenCalled();
    }),
  );

  it.effect(
    'honors a supplied partial-team choice before authenticated refresh',
    () =>
      Effect.gen(function* () {
        const deps = options({
          authenticated: true,
          providedChoice: 'continue',
        });
        expect(yield* preflightTeamAvailability(deps.input)).toMatchObject({
          status: 'proceed',
          partial: true,
        });
        expect(deps.choose).not.toHaveBeenCalled();
        expect(deps.refresh).not.toHaveBeenCalled();
      }),
  );

  it.effect('honors a supplied cancellation before authenticated refresh', () =>
    Effect.gen(function* () {
      const deps = options({ authenticated: true, providedChoice: 'cancel' });
      expect(yield* preflightTeamAvailability(deps.input)).toMatchObject({
        status: 'cancelled',
      });
      expect(deps.choose).not.toHaveBeenCalled();
      expect(deps.refresh).not.toHaveBeenCalled();
    }),
  );

  it.effect(
    'returns an actionable choice-required result without side effects',
    () =>
      Effect.gen(function* () {
        const deps = options({ choiceRequired: true });

        expect(yield* preflightTeamAvailability(deps.input)).toMatchObject({
          status: 'choice-required',
          unavailableNames: ['orchestrator'],
        });
        expect(deps.signIn).not.toHaveBeenCalled();
        expect(deps.refresh).not.toHaveBeenCalled();
      }),
  );

  it.effect('refreshes and retries exactly once after successful sign-in', () =>
    Effect.gen(function* () {
      const deps = options({ choice: 'sign-in', signedIn: true });
      expect(yield* preflightTeamAvailability(deps.input)).toMatchObject({
        status: 'proceed',
        partial: false,
      });
      expect(deps.signIn).toHaveBeenCalledOnce();
      expect(deps.refresh).toHaveBeenCalledOnce();
    }),
  );

  it.effect(
    'reports the real availability failure after authenticated refresh',
    () =>
      Effect.gen(function* () {
        const deps = options({
          authenticated: true,
          refreshed: { unresolvedNames: ['orchestrator'] },
        });
        expect(yield* preflightTeamAvailability(deps.input)).toEqual({
          status: 'unavailable',
          value: { unresolvedNames: ['orchestrator'] },
          unavailableNames: ['orchestrator'],
        });
        expect(deps.choose).not.toHaveBeenCalled();
        expect(deps.signIn).not.toHaveBeenCalled();
        expect(deps.refresh).toHaveBeenCalledOnce();
      }),
  );

  it.effect(
    'does not repeat an authenticated refresh already performed by the caller',
    () =>
      Effect.gen(function* () {
        const deps = options({
          authenticated: true,
          remoteCatalogRefreshAttempted: true,
        });
        expect(yield* preflightTeamAvailability(deps.input)).toMatchObject({
          status: 'unavailable',
          unavailableNames: ['orchestrator'],
        });
        expect(deps.refresh).not.toHaveBeenCalled();
      }),
  );
});
