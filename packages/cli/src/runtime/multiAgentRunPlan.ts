import { getAgentsByCategory, loadAgents, refresh } from '@agent/index';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { SupabaseClient } from '@auth/SupabaseClient';
import {
  findTeamPreset,
  planTeamRun,
  planTeamRuns,
  refreshRemoteCatalogForGaps,
  teamPlanHasGaps,
} from '@common/teams/TeamPlan';
import { byCategory } from '@shared/schemas';

import { missingMultiAgentPresetMessage } from './agents';
import { CliUsageError } from './cliContext';
import { writeTextStderr } from './logSinks';
import {
  formatCliMultiAgentPresetRunWarnings,
  readCliMultiAgentPresets,
  type CliMultiAgentPreset,
  type CliMultiAgentPresetRunPlan,
} from './multiAgentPresets';

interface MultiAgentRunPlanInit {
  readonly preset: string;
  readonly agent?: string;
}

export interface MultiAgentRunPlanLoadResult {
  readonly plan: CliMultiAgentPresetRunPlan;
  readonly remoteAgentLoadAttempted: boolean;
}

export interface MultiAgentPresetPlansLoadResult {
  readonly plans: readonly CliMultiAgentPresetRunPlan[];
  readonly remoteAgentLoadAttempted: boolean;
}

function planCurrentMultiAgentRun(
  init: MultiAgentRunPlanInit,
): CliMultiAgentPresetRunPlan {
  const preset = findTeamPreset(readCliMultiAgentPresets(), init.preset);
  if (!preset) {
    throw new CliUsageError(missingMultiAgentPresetMessage(init.preset));
  }
  return planTeamRun(preset, {
    agents: byCategory((category) => getAgentsByCategory(category)),
    agentOverride: init.agent,
  });
}

function planLoadedCliMultiAgentPresets(
  presets: readonly CliMultiAgentPreset[],
): CliMultiAgentPresetRunPlan[] {
  return planTeamRuns(presets, {
    agents: byCategory((category) => getAgentsByCategory(category)),
  });
}

/**
 * Resolve a preset plan, then when it still has gaps and the user is
 * authenticated, perform a remote load and replan. Relay-served premium agents
 * are only visible after a remote load. Both headless `multi-agent run` and the
 * interactive `orchestrate` menu route through this runtime helper so command
 * entrypoints cannot drift.
 */
export async function loadCliMultiAgentRunPlan(
  init: MultiAgentRunPlanInit,
  options: { readonly reloadRemoteAgents?: boolean } = {},
): Promise<MultiAgentRunPlanLoadResult> {
  await loadAgents({ includeRemote: false });
  const localPlan = planCurrentMultiAgentRun(init);
  if (options.reloadRemoteAgents === false) {
    return {
      plan: localPlan,
      remoteAgentLoadAttempted: false,
    };
  }
  const result = await refreshRemoteCatalogForGaps(
    localPlan,
    teamPlanHasGaps,
    () => planCurrentMultiAgentRun(init),
    {
      canAccessRemoteCatalog: () =>
        SupabaseClient.canAccessRemoteAgentCatalog(),
      refreshRemote: () => refresh({ includeRemote: true }),
    },
  );
  return {
    plan: result.value,
    remoteAgentLoadAttempted: result.remoteCatalogRefreshAttempted,
  };
}

export async function loadCliMultiAgentPresetPlanSet(
  presets: readonly CliMultiAgentPreset[],
): Promise<MultiAgentPresetPlansLoadResult> {
  await loadAgents({ includeRemote: false });
  const result = await refreshRemoteCatalogForGaps(
    planLoadedCliMultiAgentPresets(presets),
    (plans) => plans.some(teamPlanHasGaps),
    () => planLoadedCliMultiAgentPresets(presets),
    {
      canAccessRemoteCatalog: () =>
        SupabaseClient.canAccessRemoteAgentCatalog(),
      refreshRemote: () => refresh({ includeRemote: true }),
    },
  );
  return {
    plans: result.value,
    remoteAgentLoadAttempted: result.remoteCatalogRefreshAttempted,
  };
}

export function writeMissingPresetAgents(
  plan: CliMultiAgentPresetRunPlan,
): void {
  for (const warning of formatCliMultiAgentPresetRunWarnings(plan)) {
    writeTextStderr(warning);
  }
}
