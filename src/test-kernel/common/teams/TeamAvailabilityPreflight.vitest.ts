import { describe, expect, it, vi } from 'vitest';

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
  const refresh = vi.fn(
    async () => overrides.refreshed ?? { unresolvedNames: [] },
  );
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
      refresh,
      remoteCatalogRefreshAttempted: overrides.remoteCatalogRefreshAttempted,
    },
  };
}

describe('team availability preflight', () => {
  it('does not prompt or refresh a local-only team', async () => {
    const deps = options({ initial: { unresolvedNames: ['local-plugin'] } });
    await expect(preflightTeamAvailability(deps.input)).resolves.toEqual({
      status: 'proceed',
      value: { unresolvedNames: ['local-plugin'] },
      partial: false,
    });
    expect(deps.choose).not.toHaveBeenCalled();
    expect(deps.refresh).not.toHaveBeenCalled();
  });

  it('continues only after an explicit partial-team choice', async () => {
    const deps = options({ choice: 'continue' });
    await expect(preflightTeamAvailability(deps.input)).resolves.toMatchObject({
      status: 'proceed',
      partial: true,
    });
    expect(deps.signIn).not.toHaveBeenCalled();
    expect(deps.refresh).not.toHaveBeenCalled();
  });

  it('cancels without signing in or refreshing', async () => {
    const deps = options({ choice: 'cancel' });
    await expect(preflightTeamAvailability(deps.input)).resolves.toMatchObject({
      status: 'cancelled',
    });
    expect(deps.signIn).not.toHaveBeenCalled();
    expect(deps.refresh).not.toHaveBeenCalled();
  });

  it('honors a supplied partial-team choice before authenticated refresh', async () => {
    const deps = options({ authenticated: true, providedChoice: 'continue' });
    await expect(preflightTeamAvailability(deps.input)).resolves.toMatchObject({
      status: 'proceed',
      partial: true,
    });
    expect(deps.choose).not.toHaveBeenCalled();
    expect(deps.refresh).not.toHaveBeenCalled();
  });

  it('honors a supplied cancellation before authenticated refresh', async () => {
    const deps = options({ authenticated: true, providedChoice: 'cancel' });
    await expect(preflightTeamAvailability(deps.input)).resolves.toMatchObject({
      status: 'cancelled',
    });
    expect(deps.choose).not.toHaveBeenCalled();
    expect(deps.refresh).not.toHaveBeenCalled();
  });

  it('returns an actionable choice-required result without side effects', async () => {
    const deps = options({ choiceRequired: true });

    await expect(preflightTeamAvailability(deps.input)).resolves.toMatchObject({
      status: 'choice-required',
      unavailableNames: ['orchestrator'],
    });
    expect(deps.signIn).not.toHaveBeenCalled();
    expect(deps.refresh).not.toHaveBeenCalled();
  });

  it('refreshes and retries exactly once after successful sign-in', async () => {
    const deps = options({ choice: 'sign-in', signedIn: true });
    await expect(preflightTeamAvailability(deps.input)).resolves.toMatchObject({
      status: 'proceed',
      partial: false,
    });
    expect(deps.signIn).toHaveBeenCalledOnce();
    expect(deps.refresh).toHaveBeenCalledOnce();
  });

  it('reports the real availability failure after authenticated refresh', async () => {
    const deps = options({
      authenticated: true,
      refreshed: { unresolvedNames: ['orchestrator'] },
    });
    await expect(preflightTeamAvailability(deps.input)).resolves.toEqual({
      status: 'unavailable',
      value: { unresolvedNames: ['orchestrator'] },
      unavailableNames: ['orchestrator'],
    });
    expect(deps.choose).not.toHaveBeenCalled();
    expect(deps.signIn).not.toHaveBeenCalled();
    expect(deps.refresh).toHaveBeenCalledOnce();
  });

  it('does not repeat an authenticated refresh already performed by the caller', async () => {
    const deps = options({
      authenticated: true,
      remoteCatalogRefreshAttempted: true,
    });
    await expect(preflightTeamAvailability(deps.input)).resolves.toMatchObject({
      status: 'unavailable',
      unavailableNames: ['orchestrator'],
    });
    expect(deps.refresh).not.toHaveBeenCalled();
  });
});
