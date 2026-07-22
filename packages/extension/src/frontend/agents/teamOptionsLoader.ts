import { getAgentsByCategory, refresh } from '@agent/index';
import { SupabaseClient } from '@auth/SupabaseClient';
import { loadTeamOptions } from '@common/teams/TeamPlan';
import { platform } from '@platform/platform';
import type { TeamOptionData } from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';

export function loadMainViewTeamOptions(): Promise<TeamOptionData[]> {
  return loadTeamOptions({
    customPresetsRaw: platform().workspaceState.get<unknown>(
      WorkspaceStateKey.CUSTOM_AGENT_PRESETS,
    ),
    getAgents: getAgentsByCategory,
    canAccessRemoteCatalog: () => SupabaseClient.canAccessRemoteAgentCatalog(),
    refreshRemote: () => refresh({ includeRemote: true }),
  });
}
