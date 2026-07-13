// Local imports
import { getAgentsByCategory } from '@agent/index/agentRegistry';
import type { TeamRosterState } from '@common/teams/TeamRoster';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import type { StateStore } from '@platform/interfaces';

/**
 * Adapt the live agent registry and workspace state to the team-roster port.
 * Callers must load the registry before resolving a roster through this state.
 */
export function createRegistryTeamRosterState(
  workspaceState: StateStore,
): TeamRosterState {
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
