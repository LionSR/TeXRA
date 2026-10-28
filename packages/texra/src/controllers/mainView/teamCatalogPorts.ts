// Local imports
import { Effect } from 'effect';
import { AgentCatalog, type StateStore } from '@texra-ai/harness/host';
import { WorkspaceStateKey } from '@texra-ai/harness/schemas';
import { BUILTIN_TEAM_ROOT_AGENT_NAMES } from '@texra/shared/constants/agents';

/**
 * Live team-catalog ports shared by every host's main view. Launch resolution
 * (`resolveTeamLaunch`) and team-option loading (`loadTeamOptions`) must plan
 * against the same catalog, so both build their ports here: the workspace
 * presets are re-read on each call and the agent ports stay live functions.
 */
export const createTeamCatalogPorts = Effect.fn('createTeamCatalogPorts')(
  function* (repoState: StateStore) {
    return {
      customPresetsRaw: yield* repoState.get(WorkspaceStateKey.CUSTOM_TEAMS),
      resolveAgent: (yield* AgentCatalog).get,
      rootAgentNames: BUILTIN_TEAM_ROOT_AGENT_NAMES,
    };
  },
);
