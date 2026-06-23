/**
 * Default-team seeding of fresh workspaces (PRD: agent-native onboarding,
 * "Dropdown hygiene" item 1).
 *
 * The setup agent's `apply_team` tool records a user-level default team id.
 * When a workspace has never configured its agent roster, host activation
 * seeds both roster keys from that team so the user's discipline choice
 * follows them into every new project. If no user-level default has been
 * recorded yet, fresh workspaces start from the built-in Physicist team so
 * startup menus do not expose the full agent catalog by default.
 */

import {
  applyPresetRoster,
  type PresetRosterState,
} from '@controllers/settingsView/SettingsAgentCatalogController';
import { getAgentsByCategory } from '@agent/index/agentRegistry';
import {
  AGENT_MODE_PRESETS_BY_ID,
  STARTER_AGENT_MODE_PRESET,
  type AgentModePreset,
} from '@shared/schemas/agentPresets';
import { WorkspaceStateKey } from '@shared/state/stateKeys';

import { getDefaultTeamId } from './onboardingFunnel';

import type { StateStore } from '@platform/interfaces/state';

const FALLBACK_STARTUP_TEAM_ID = 'physicist';

/** Resolve a team id to its built-in preset (the hidden 'starter' included). */
export function resolveTeamPreset(teamId: string): AgentModePreset | undefined {
  if (teamId === STARTER_AGENT_MODE_PRESET.id) return STARTER_AGENT_MODE_PRESET;
  return AGENT_MODE_PRESETS_BY_ID.get(teamId);
}

/**
 * Roster port over the live agent registry and a workspace state store — the
 * same name-resolution and key-writing path the Settings catalog uses.
 * Requires the agent registry to be loaded; callers sequence after
 * `loadAgents`.
 */
export function registryPresetRosterState(
  workspaceState: StateStore,
): PresetRosterState {
  return {
    getAgents: (category) => getAgentsByCategory(category),
    setEnabledAgentKeys: async (category, enabledKeys) => {
      await workspaceState.update(
        category === 'workflow'
          ? WorkspaceStateKey.ENABLED_AGENTS
          : WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS,
        enabledKeys,
      );
    },
  };
}

/**
 * Seed this workspace's agent roster from the user-level default team.
 * No-op unless BOTH roster keys are unset (never configured) AND the selected
 * team resolves to a known preset. Returns whether seeding happened.
 */
export async function seedRosterFromDefaultTeam(stores: {
  globalState: StateStore;
  workspaceState: StateStore;
}): Promise<boolean> {
  const { globalState, workspaceState } = stores;
  if (
    workspaceState.get(WorkspaceStateKey.ENABLED_AGENTS) !== undefined ||
    workspaceState.get(WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS) !== undefined
  ) {
    return false;
  }
  const teamId = getDefaultTeamId(globalState) ?? FALLBACK_STARTUP_TEAM_ID;
  const preset = resolveTeamPreset(teamId);
  if (!preset) return false;
  await applyPresetRoster(registryPresetRosterState(workspaceState), preset);
  return true;
}
