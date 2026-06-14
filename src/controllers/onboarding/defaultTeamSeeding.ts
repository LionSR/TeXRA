/**
 * Default-team seeding of fresh workspaces (PRD: agent-native onboarding,
 * "Dropdown hygiene" item 1).
 *
 * The setup agent's `apply_team` tool records a user-level default team id;
 * when a workspace has never configured its agent roster, host activation
 * seeds both roster keys from that team so the user's discipline choice
 * follows them into every new project. Absent a default team, nothing
 * happens (`undefined → show all`, unchanged).
 *
 * This replaces install-detection heuristics entirely: pre-existing users
 * have no default team, so no workspace ever shows them a shrunken dropdown;
 * post-setup users get their chosen roster in every fresh folder.
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
 * No-op unless BOTH roster keys are unset (never configured) AND the default
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
  const teamId = getDefaultTeamId(globalState);
  if (!teamId) return false;
  const preset = resolveTeamPreset(teamId);
  if (!preset) return false;
  await applyPresetRoster(registryPresetRosterState(workspaceState), preset);
  return true;
}
