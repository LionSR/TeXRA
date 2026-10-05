// Local imports
import { Effect } from 'effect';
import { getCatalogAgent } from '@agent/index';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import type { StateStore } from '@texra-ai/harness';

/**
 * Live team-catalog ports shared by every host's main view. Launch resolution
 * (`resolveTeamLaunch`) and team-option loading (`loadTeamOptions`) must plan
 * against the same catalog, so both build their ports here: the workspace
 * presets are re-read on each call and the agent ports stay live functions.
 */
export function createTeamCatalogPorts(repoState: StateStore) {
  return Effect.gen(function* () {
    return {
      customPresetsRaw: yield* repoState.get(WorkspaceStateKey.CUSTOM_TEAMS),
      resolveAgent: getCatalogAgent,
    };
  });
}
