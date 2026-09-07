// Local imports
import { getAgentsByCategory, loadAgents, refresh } from '@agent/index';
import { SupabaseClient } from '@auth/SupabaseClient';
import { workspaceRoots } from '@platform/workspaceRoots';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import type { Effect } from 'effect';

/**
 * Live team-catalog ports shared by every host's main view. Launch resolution
 * (`resolveTeamLaunch`) and team-option loading (`loadTeamOptions`) must plan
 * against the same catalog, so both build their ports here: the workspace
 * presets are re-read on each call and the agent/auth ports stay live
 * functions. Hosts add only their dialog glue (choose/signIn) on top.
 */
export function createTeamCatalogPorts(): {
  readonly customPresetsRaw: unknown;
  readonly ensureCatalogLoaded: () => Effect.Effect<void, unknown>;
  readonly getAgents: typeof getAgentsByCategory;
  readonly canAccessRemoteCatalog: () => Promise<boolean>;
  readonly refreshRemote: () => Effect.Effect<void, unknown>;
} {
  return {
    customPresetsRaw: workspaceRoots().workspaceState.get<unknown>(
      WorkspaceStateKey.CUSTOM_AGENT_PRESETS,
    ),
    ensureCatalogLoaded: () => loadAgents(),
    getAgents: getAgentsByCategory,
    canAccessRemoteCatalog: () => SupabaseClient.isAuthenticated(),
    refreshRemote: () => refresh({ includeRemote: true }),
  };
}
