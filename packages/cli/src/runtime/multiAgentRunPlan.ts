import { getAgentsByCategory, loadAgents, refresh } from '@agent/index';
import { SupabaseClient } from '@auth/SupabaseClient';
import {
  findTeamPreset,
  planTeamRun,
  planTeamRuns,
  refreshRemoteCatalogForGaps,
  teamPlanHasGaps,
} from '@common/teams/TeamPlan';
import { byCategory, AgentCategory } from '@shared/schemas';

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
  readonly remoteCatalogRefreshAttempted: boolean;
}

export interface MultiAgentPresetPlansLoadResult {
  readonly plans: readonly CliMultiAgentPresetRunPlan[];
  readonly remoteCatalogRefreshAttempted: boolean;
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
      remoteCatalogRefreshAttempted: false,
    };
  }
  const result = await reloadRemoteAgentsForGaps(
    localPlan,
    teamPlanHasGaps,
    () => planCurrentMultiAgentRun(init),
  );
  return {
    plan: result.value,
    remoteCatalogRefreshAttempted: result.remoteCatalogRefreshAttempted,
  };
}

export async function loadCliMultiAgentPresetPlanSet(
  presets: readonly CliMultiAgentPreset[],
): Promise<MultiAgentPresetPlansLoadResult> {
  await loadAgents({ includeRemote: false });
  const result = await reloadRemoteAgentsForGaps(
    planLoadedCliMultiAgentPresets(presets),
    (plans) => plans.some(teamPlanHasGaps),
    () => planLoadedCliMultiAgentPresets(presets),
  );
  return {
    plans: result.value,
    remoteCatalogRefreshAttempted: result.remoteCatalogRefreshAttempted,
  };
}

async function reloadRemoteAgentsForGaps<T>(
  value: T,
  hasGaps: (value: T) => boolean,
  replan: () => T,
): Promise<{
  readonly value: T;
  readonly remoteCatalogRefreshAttempted: boolean;
}> {
  return refreshRemoteCatalogForGaps(value, hasGaps, replan, {
    canAccessRemoteCatalog: () => SupabaseClient.canAccessRemoteAgentCatalog(),
    refreshRemote: () => refresh({ includeRemote: true }),
  });
}

export function writeMissingPresetAgents(
  plan: CliMultiAgentPresetRunPlan,
): void {
  for (const warning of formatCliMultiAgentPresetRunWarnings(plan)) {
    writeTextStderr(warning);
  }
}
