import { describe, expect, it, vi } from 'vitest';

import {
  applyTeamRosterWithPreflight,
  type TeamRosterApplicationDeps,
} from '@common/teams/TeamRosterApplication';
import { applySettingsTeamRoster } from '@controllers/settingsView/SettingsTeamRosterController';
import type { AgentModePreset } from '@shared/schemas';

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
      commitPresetResolution: vi.fn(),
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
    const commitPresetResolution = vi.fn(async () => {
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
          commitPresetResolution,
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
    expect(commitPresetResolution).toHaveBeenCalledOnce();
    expect(commitPresetResolution).toHaveBeenCalledWith(preset, resolved);
  });

  it('cancels before refresh or roster writes', async () => {
    const commitPresetResolution = vi.fn();
    const forceRefreshRemoteCatalog = vi.fn();
    const signIn = vi.fn();

    const result = await applyTeamRosterWithPreflight(
      'research',
      makeDeps({
        catalog: { commitPresetResolution },
        signIn,
        forceRefreshRemoteCatalog,
      }),
    );

    expect(result).toEqual({ status: 'cancelled', preset });
    expect(signIn).not.toHaveBeenCalled();
    expect(forceRefreshRemoteCatalog).not.toHaveBeenCalled();
    expect(commitPresetResolution).not.toHaveBeenCalled();
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
    const commitPresetResolution = vi.fn();

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
          commitPresetResolution,
        },
        choose: async (_preset, names) => choose(names),
      }),
    );

    expect(result.status).toBe('cancelled');
    expect(choose).toHaveBeenCalledWith(['remoteSpecialist']);
    expect(commitPresetResolution).not.toHaveBeenCalled();
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

  it('refreshes the host before presenting a successful settings application', async () => {
    const calls: string[] = [];
    const getPresetToolUseRoot = vi.fn(() => 'orchestrator');

    await applySettingsTeamRoster('research', {
      catalog: {
        resolvePreset: () => ({ ok: true, preset, resolution: resolved }),
        commitPresetResolution: async () => {
          calls.push('apply');
        },
        getPresetToolUseRoot,
      },
      loadLocalCatalog: async () => {},
      canAccessRemoteCatalog: async () => false,
      signIn: async () => false,
      forceRefreshRemoteCatalog: async () => {},
      presentation: {
        chooseTeamAvailability: async () => 'cancel',
        showErrorMessage: async () => {},
        showInfoMessage: async (message) => {
          calls.push(`info:${message}`);
        },
      },
      refreshAfterApply: async (selectedToolUseAgent) => {
        calls.push(`refresh:${selectedToolUseAgent}`);
      },
    });

    expect(getPresetToolUseRoot).toHaveBeenCalledWith(
      ['orchestrator'],
      'research',
    );
    expect(calls).toEqual([
      'apply',
      'refresh:orchestrator',
      'info:Applied "Research" team',
    ]);
  });

  it('presents canonical unavailable-member choices and errors', async () => {
    const prompts: unknown[] = [];
    const errors: string[] = [];

    await applySettingsTeamRoster('research', {
      catalog: {
        resolvePreset: () => ({ ok: true, preset, resolution: unresolved }),
        commitPresetResolution: vi.fn(),
        getPresetToolUseRoot: vi.fn(),
      },
      loadLocalCatalog: async () => {},
      canAccessRemoteCatalog: async () => false,
      signIn: async () => true,
      forceRefreshRemoteCatalog: async () => {},
      presentation: {
        chooseTeamAvailability: async (prompt) => {
          prompts.push(prompt);
          return 'sign-in';
        },
        showErrorMessage: async (message) => {
          errors.push(message);
        },
        showInfoMessage: async () => {},
      },
      refreshAfterApply: async () => {},
    });

    expect(prompts).toEqual([
      {
        severity: 'warning',
        message:
          'Team "Research" has unavailable TeXRA-hosted members: orchestrator.',
        actions: [
          { choice: 'sign-in', label: 'Sign In to TeXRA' },
          {
            choice: 'continue',
            label: 'Continue with Available Members',
          },
          { choice: 'cancel', label: 'Cancel' },
        ],
      },
    ]);
    expect(errors).toEqual(['Team "Research" is unavailable: orchestrator.']);
  });

  it('proceeds on a provided "continue" choice without prompting or signing in', async () => {
    const choose = vi.fn();
    const signIn = vi.fn();
    const commitPresetResolution = vi.fn();

    const result = await applyTeamRosterWithPreflight(
      'research',
      makeDeps({
        catalog: { commitPresetResolution },
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
    expect(commitPresetResolution).toHaveBeenCalledWith(preset, unresolved);
  });
});
