// Local imports
import { getAgentsByCategory, loadAgents, refresh } from '@agent/index';
import { SupabaseClient } from '@auth/SupabaseClient';
import { platform } from '@platform/platform';
import { WorkspaceStateKey } from '@shared/state/stateKeys';

/**
 * Live team-catalog ports shared by every host's main view. Launch resolution
 * (`resolveTeamLaunch`) and team-option loading (`loadTeamOptions`) must plan
 * against the same catalog, so both build their ports here: the workspace
 * presets are re-read on each call and the agent/auth ports stay live
 * functions. Hosts add only their dialog glue (choose/signIn) on top.
 */
export function createTeamCatalogPorts(): {
  readonly customPresetsRaw: unknown;
  readonly ensureCatalogLoaded: () => Promise<void>;
  readonly getAgents: typeof getAgentsByCategory;
  readonly canAccessRemoteCatalog: () => Promise<boolean>;
  readonly refreshRemote: () => Promise<void>;
} {
  return {
    customPresetsRaw: platform().workspaceState.get<unknown>(
      WorkspaceStateKey.CUSTOM_AGENT_PRESETS,
    ),
    ensureCatalogLoaded: loadAgents,
    getAgents: getAgentsByCategory,
    canAccessRemoteCatalog: () => SupabaseClient.canAccessRemoteAgentCatalog(),
    refreshRemote: () => refresh({ includeRemote: true }),
  };
}
