import { describe, expect, it, vi } from 'vitest';

import {
  applyTeamRosterWithPreflight,
  type TeamRosterApplicationDeps,
} from '@common/teams/TeamRosterApplication';
import type { AgentModePreset } from '@shared/schemas/agentPresets';

const preset: AgentModePreset = {
  id: 'research',
  name: 'Research',
  description: 'Research team',
  icon: 'bookmark',
  agents: {
    workflow: [],
    toolUse: ['orchestrator'],
  },
  texraHostedAgents: ['orchestrator'],
};

const unresolved = {
  keys: {
    workflow: [],
    toolUse: [],
  },
  nameSlots: {
    workflow: [],
    toolUse: ['orchestrator'],
  },
  unresolvedNames: ['orchestrator'],
};

const resolved = {
  keys: {
    workflow: [],
    toolUse: ['remote:orchestrator'],
  },
  nameSlots: {
    workflow: [],
    toolUse: [],
  },
  unresolvedNames: [],
};

function makeDeps(
  overrides: Partial<Omit<TeamRosterApplicationDeps, 'catalog'>> & {
    catalog?: Partial<TeamRosterApplicationDeps['catalog']>;
  } = {},
): TeamRosterApplicationDeps {
  const { catalog, ...rest } = overrides;
  return {
    catalog: {
      resolvePreset: () => ({ ok: true, preset, resolution: unresolved }),
      commitPreset: vi.fn(),
      ...catalog,
    },
    loadLocalCatalog: async () => {},
    canAccessRemoteCatalog: async () => false,
    choose: async () => 'cancel',
    signIn: async () => false,
    forceRefreshRemoteCatalog: async () => {},
    ...rest,
  };
}

describe('team roster application', () => {
  it('signs in, forces one refresh, and commits exactly once', async () => {
    const calls: string[] = [];
    let refreshed = false;
    const commitPreset = vi.fn(async () => {
      calls.push('commit');
    });

    const result = await applyTeamRosterWithPreflight(
      'research',
      makeDeps({
        catalog: {
          resolvePreset: () => ({
            ok: true,
            preset,
            resolution: refreshed ? resolved : unresolved,
          }),
          commitPreset,
        },
        loadLocalCatalog: async () => {
          calls.push('local-load');
        },
        choose: async () => {
          calls.push('choose');
          return 'sign-in';
        },
        signIn: async () => {
          calls.push('sign-in');
          return true;
        },
        forceRefreshRemoteCatalog: async () => {
          calls.push('forced-refresh');
          refreshed = true;
        },
      }),
    );

    expect(result).toEqual({
      status: 'applied',
      preset,
      resolution: resolved,
    });
    expect(calls).toEqual([
      'local-load',
      'choose',
      'sign-in',
      'forced-refresh',
      'commit',
    ]);
    expect(commitPreset).toHaveBeenCalledOnce();
    expect(commitPreset).toHaveBeenCalledWith(preset);
  });

  it('cancels before refresh or roster writes', async () => {
    const commitPreset = vi.fn();
    const forceRefreshRemoteCatalog = vi.fn();
    const signIn = vi.fn();

    const result = await applyTeamRosterWithPreflight(
      'research',
      makeDeps({
        catalog: { commitPreset },
        signIn,
        forceRefreshRemoteCatalog,
      }),
    );

    expect(result).toEqual({ status: 'cancelled', preset });
    expect(signIn).not.toHaveBeenCalled();
    expect(forceRefreshRemoteCatalog).not.toHaveBeenCalled();
    expect(commitPreset).not.toHaveBeenCalled();
  });

  it('preflights an arbitrary unresolved member in a legacy custom team', async () => {
    const legacyPreset: AgentModePreset = {
      id: 'legacy',
      name: 'Legacy',
      description: 'Saved before hosted provenance',
      icon: 'bookmark',
      agents: {
        workflow: [],
        toolUse: ['review', 'remoteSpecialist'],
      },
    };
    const choose = vi.fn(
      async (_names: readonly string[]) => 'cancel' as const,
    );
    const commitPreset = vi.fn();

    const result = await applyTeamRosterWithPreflight(
      'legacy',
      makeDeps({
        catalog: {
          resolvePreset: () => ({
            ok: true,
            preset: legacyPreset,
            resolution: {
              keys: {
                workflow: [],
                toolUse: ['builtInToolUse:review'],
              },
              nameSlots: {
                workflow: [],
                toolUse: ['remoteSpecialist'],
              },
              unresolvedNames: ['remoteSpecialist'],
            },
          }),
          commitPreset,
        },
        choose: async (_preset, names) => choose(names),
      }),
    );

    expect(result.status).toBe('cancelled');
    expect(choose).toHaveBeenCalledWith(['remoteSpecialist']);
    expect(commitPreset).not.toHaveBeenCalled();
  });

  it('preflights recognized and arbitrary unresolved members in a mixed legacy team', async () => {
    const legacyPreset: AgentModePreset = {
      id: 'mixed-legacy',
      name: 'Mixed legacy',
      description: 'Contains local and remote members without provenance',
      icon: 'bookmark',
      agents: {
        workflow: ['generic'],
        toolUse: ['review', 'remoteSpecialist'],
      },
    };
    const choose = vi.fn(
      async (_names: readonly string[]) => 'cancel' as const,
    );

    await applyTeamRosterWithPreflight(
      'mixed-legacy',
      makeDeps({
        catalog: {
          resolvePreset: () => ({
            ok: true,
            preset: legacyPreset,
            resolution: {
              keys: {
                workflow: [],
                toolUse: ['builtInToolUse:review'],
              },
              nameSlots: {
                workflow: ['generic'],
                toolUse: ['remoteSpecialist'],
              },
              unresolvedNames: ['generic', 'remoteSpecialist'],
            },
          }),
        },
        choose: async (_preset, names) => choose(names),
      }),
    );

    expect(choose).toHaveBeenCalledWith(['generic', 'remoteSpecialist']);
    expect(legacyPreset).not.toHaveProperty('texraHostedAgents');
  });

  it('proceeds on a provided "continue" choice without prompting or signing in', async () => {
    const choose = vi.fn();
    const signIn = vi.fn();
    const commitPreset = vi.fn();

    const result = await applyTeamRosterWithPreflight(
      'research',
      makeDeps({
        catalog: { commitPreset },
        providedChoice: 'continue',
        choose,
        signIn,
      }),
    );

    expect(result).toEqual({
      status: 'applied',
      preset,
      resolution: unresolved,
    });
    expect(choose).not.toHaveBeenCalled();
    expect(signIn).not.toHaveBeenCalled();
    expect(commitPreset).toHaveBeenCalledWith(preset);
  });
});
