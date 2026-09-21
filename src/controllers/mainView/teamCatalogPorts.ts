// Local imports
import { Effect, FileSystem } from 'effect';
import { getAgentsByCategory, loadAgents, refresh } from '@agent/index';
import { supabaseAuthenticated } from '@auth/SupabaseAuth';
import type { AgentDirectories, StateStore } from '@platform/interfaces';
import type { GlobalStorageFs } from '@platform/rootedFs';
import { WorkspaceStateKey } from '@shared/state/stateKeys';

/**
 * Live team-catalog ports shared by every host's main view. Launch resolution
 * (`resolveTeamLaunch`) and team-option loading (`loadTeamOptions`) must plan
 * against the same catalog, so both build their ports here: the workspace
 * presets are re-read on each call and the agent/auth ports stay live
 * functions. Hosts add only their dialog glue (choose/signIn) on top.
 */
export function createTeamCatalogPorts(workspaceState: StateStore): {
  readonly customPresetsRaw: unknown;
  readonly ensureCatalogLoaded: () => Effect.Effect<
    void,
    unknown,
    GlobalStorageFs | FileSystem.FileSystem | AgentDirectories
  >;
  readonly getAgents: typeof getAgentsByCategory;
  readonly canAccessRemoteCatalog: () => Effect.Effect<boolean>;
  readonly refreshRemote: () => Effect.Effect<
    void,
    unknown,
    GlobalStorageFs | FileSystem.FileSystem | AgentDirectories
  >;
} {
  return {
    customPresetsRaw: workspaceState.get<unknown>(
      WorkspaceStateKey.CUSTOM_AGENT_PRESETS,
    ),
    ensureCatalogLoaded: () => loadAgents(),
    getAgents: getAgentsByCategory,
    canAccessRemoteCatalog: () => supabaseAuthenticated,
    refreshRemote: () => refresh({ includeRemote: true }),
  };
}
