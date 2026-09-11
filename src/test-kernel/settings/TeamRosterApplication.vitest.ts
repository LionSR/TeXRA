import { it } from '@effect/vitest';
import { describe, expect, vi } from 'vitest';

import { Effect } from 'effect';
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
      commitPreset: vi.fn(),
      ...catalog,
    },
    loadLocalCatalog: () => Effect.void,
    canAccessRemoteCatalog: async () => false,
    choose: async () => 'cancel',
    signIn: async () => false,
    forceRefreshRemoteCatalog: () => Effect.void,
    ...rest,
  };
}

describe('team roster application', () => {
  it.effect('signs in, forces one refresh, and commits exactly once', () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      let refreshed = false;
      const commitPreset = vi.fn(async () => {
        calls.push('commit');
      });

      const result = yield* applyTeamRosterWithPreflight(
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
          loadLocalCatalog: () =>
            Effect.sync(() => {
              calls.push('local-load');
            }),
          choose: async () => {
            calls.push('choose');
            return 'sign-in';
          },
          signIn: async () => {
            calls.push('sign-in');
            return true;
          },
          forceRefreshRemoteCatalog: () =>
            Effect.sync(() => {
              calls.push('forced-refresh');
              refreshed = true;
            }),
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
    }),
  );

  it.effect('cancels before refresh or roster writes', () =>
    Effect.gen(function* () {
      const commitPreset = vi.fn();
      let forcedRefresh = false;
      const signIn = vi.fn();

      const result = yield* applyTeamRosterWithPreflight(
        'research',
        makeDeps({
          catalog: { commitPreset },
          signIn,
          forceRefreshRemoteCatalog: () =>
            Effect.sync(() => {
              forcedRefresh = true;
            }),
        }),
      );

      expect(result).toEqual({ status: 'cancelled', preset });
      expect(signIn).not.toHaveBeenCalled();
      expect(forcedRefresh).toBe(false);
      expect(commitPreset).not.toHaveBeenCalled();
    }),
  );

  it.effect(
    'refreshes the host before presenting a successful settings application',
    () =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const getPresetToolUseRoot = vi.fn(() => 'orchestrator');

        yield* applySettingsTeamRoster('research', {
          catalog: {
            resolvePreset: () => ({ ok: true, preset, resolution: resolved }),
            commitPreset: async () => {
              calls.push('apply');
            },
            getPresetToolUseRoot,
          },
          loadLocalCatalog: () => Effect.void,
          canAccessRemoteCatalog: async () => false,
          signIn: async () => false,
          forceRefreshRemoteCatalog: () => Effect.void,
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
      }),
  );

  it.effect('presents canonical unavailable-member choices and errors', () =>
    Effect.gen(function* () {
      const prompts: unknown[] = [];
      const errors: string[] = [];

      yield* applySettingsTeamRoster('research', {
        catalog: {
          resolvePreset: () => ({ ok: true, preset, resolution: unresolved }),
          commitPreset: vi.fn(),
          getPresetToolUseRoot: vi.fn(),
        },
        loadLocalCatalog: () => Effect.void,
        canAccessRemoteCatalog: async () => false,
        signIn: async () => true,
        forceRefreshRemoteCatalog: () => Effect.void,
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
    }),
  );

  it.effect(
    'proceeds on a provided "continue" choice without prompting or signing in',
    () =>
      Effect.gen(function* () {
        const choose = vi.fn();
        const signIn = vi.fn();
        const commitPreset = vi.fn();

        const result = yield* applyTeamRosterWithPreflight(
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
      }),
  );
});
