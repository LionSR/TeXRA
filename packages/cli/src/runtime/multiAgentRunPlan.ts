import { getAgentsByCategory, loadAgents, refresh } from '@agent/index';
import { supabaseAuthenticated } from '@auth/SupabaseAuth';
import {
  findTeamPreset,
  planTeamRun,
  planTeamRuns,
  refreshRemoteCatalogForGaps,
  teamPlanHasGaps,
  type TeamPreset,
} from '@common/teams/TeamPlan';
import type { StateStore } from '@platform/interfaces';
import type { ProcessRuntime } from '@platform/processRuntime';
import { byCategory } from '@shared/schemas';

import { missingMultiAgentPresetMessage } from './agents';
import { CliUsageError } from './cliContext';
import { writeTextStderr } from './logSinks';
import {
  formatCliMultiAgentPresetRunWarnings,
  readCliMultiAgentPresets,
  type CliMultiAgentPresetRunPlan,
} from './multiAgentPresets';

interface MultiAgentRunPlanInit {
  readonly preset: string;
  readonly agent?: string;
}

interface MultiAgentRunPlanLoadResult {
  readonly plan: CliMultiAgentPresetRunPlan;
  readonly remoteCatalogRefreshAttempted: boolean;
}

interface MultiAgentPresetPlansLoadResult {
  readonly plans: readonly CliMultiAgentPresetRunPlan[];
  readonly remoteCatalogRefreshAttempted: boolean;
}

function planCurrentMultiAgentRun(
  init: MultiAgentRunPlanInit,
  workspaceState: StateStore,
): CliMultiAgentPresetRunPlan {
  const preset = findTeamPreset(
    readCliMultiAgentPresets(workspaceState),
    init.preset,
  );
  if (!preset) {
    throw new CliUsageError(missingMultiAgentPresetMessage(init.preset));
  }
  return planTeamRun(preset, {
    agents: byCategory((category) => getAgentsByCategory(category)),
    agentOverride: init.agent,
  });
}

function planLoadedCliMultiAgentPresets(
  presets: readonly TeamPreset[],
): CliMultiAgentPresetRunPlan[] {
  return planTeamRuns(presets, {
    agents: byCategory((category) => getAgentsByCategory(category)),
  });
}

/**
 * Resolve a preset plan, then when it still has gaps and the user is
 * authenticated, perform a remote load and replan. Account-served remote agents
 * are only visible after a remote load. Headless `multi-agent run` routes
 * through this runtime helper so command entrypoints cannot drift.
 */
export async function loadCliMultiAgentRunPlan(
  runtime: ProcessRuntime,
  init: MultiAgentRunPlanInit,
  workspaceState: StateStore,
  options: { readonly reloadRemoteAgents?: boolean } = {},
): Promise<MultiAgentRunPlanLoadResult> {
  await runtime.runPromise(loadAgents({ includeRemote: false }));
  const localPlan = planCurrentMultiAgentRun(init, workspaceState);
  if (options.reloadRemoteAgents === false) {
    return {
      plan: localPlan,
      remoteCatalogRefreshAttempted: false,
    };
  }
  const result = await reloadRemoteAgentsForGaps(
    runtime,
    localPlan,
    teamPlanHasGaps,
    () => planCurrentMultiAgentRun(init, workspaceState),
  );
  return {
    plan: result.value,
    remoteCatalogRefreshAttempted: result.remoteCatalogRefreshAttempted,
  };
}

export async function loadCliMultiAgentPresetPlanSet(
  runtime: ProcessRuntime,
  presets: readonly TeamPreset[],
): Promise<MultiAgentPresetPlansLoadResult> {
  await runtime.runPromise(loadAgents({ includeRemote: false }));
  const result = await reloadRemoteAgentsForGaps(
    runtime,
    planLoadedCliMultiAgentPresets(presets),
    (plans) => plans.some(teamPlanHasGaps),
    () => planLoadedCliMultiAgentPresets(presets),
  );
  return {
    plans: result.value,
    remoteCatalogRefreshAttempted: result.remoteCatalogRefreshAttempted,
  };
}

function reloadRemoteAgentsForGaps<T>(
  runtime: ProcessRuntime,
  value: T,
  hasGaps: (value: T) => boolean,
  replan: () => T,
): Promise<{
  readonly value: T;
  readonly remoteCatalogRefreshAttempted: boolean;
}> {
  return runtime.runPromise(
    refreshRemoteCatalogForGaps(value, hasGaps, replan, {
      canAccessRemoteCatalog: () => supabaseAuthenticated,
      refreshRemote: () => refresh({ includeRemote: true }),
    }),
  );
}

export function writeMissingPresetAgents(
  plan: CliMultiAgentPresetRunPlan,
): void {
  for (const warning of formatCliMultiAgentPresetRunWarnings(plan)) {
    writeTextStderr(warning);
  }
}
