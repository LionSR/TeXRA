import { Effect } from 'effect';

import { getCategoryAgent, loadAgents, refresh } from '@agent/index';
import { supabaseAuthenticated } from '@auth/SupabaseAuth';
import {
  planTeamRun,
  planTeamRuns,
  refreshRemoteCatalogForGaps,
  teamPlanHasGaps,
} from '@common/teams/TeamPlan';
import { findTeamPreset, type TeamPreset } from '@common/teams/TeamPresets';
import type { StateStore } from '@platform/interfaces';

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
  preset: TeamPreset,
  init: MultiAgentRunPlanInit,
): CliMultiAgentPresetRunPlan {
  return planTeamRun(preset, {
    resolveAgent: getCategoryAgent,
    agentOverride: init.agent,
  });
}

function planLoadedCliMultiAgentPresets(
  presets: readonly TeamPreset[],
): CliMultiAgentPresetRunPlan[] {
  return planTeamRuns(presets, { resolveAgent: getCategoryAgent });
}

/**
 * Resolve a preset plan, then when it still has gaps and the user is
 * authenticated, perform a remote load and replan. Account-served remote agents
 * are only visible after a remote load. Headless `multi-agent run` routes
 * through this runtime helper so command entrypoints cannot drift.
 */
export function loadCliMultiAgentRunPlan(
  init: MultiAgentRunPlanInit,
  workspaceState: StateStore,
  options: { readonly reloadRemoteAgents?: boolean } = {},
) {
  return Effect.gen(function* () {
    yield* loadAgents({ includeRemote: false });
    // Resolved once, before any replan: the remote reload below refreshes the
    // agent catalog, never the workspace's team presets, so a preset that was
    // found here cannot go missing under it.
    const preset = findTeamPreset(
      yield* readCliMultiAgentPresets(workspaceState),
      init.preset,
    );
    if (!preset) {
      return yield* Effect.fail(
        new CliUsageError(missingMultiAgentPresetMessage(init.preset)),
      );
    }
    const localPlan = planCurrentMultiAgentRun(preset, init);
    if (options.reloadRemoteAgents === false) {
      return {
        plan: localPlan,
        remoteCatalogRefreshAttempted: false,
      } satisfies MultiAgentRunPlanLoadResult;
    }
    const result = yield* reloadRemoteAgentsForGaps(
      localPlan,
      teamPlanHasGaps,
      () => planCurrentMultiAgentRun(preset, init),
    );
    return {
      plan: result.value,
      remoteCatalogRefreshAttempted: result.remoteCatalogRefreshAttempted,
    } satisfies MultiAgentRunPlanLoadResult;
  });
}

export function loadCliMultiAgentPresetPlanSet(presets: readonly TeamPreset[]) {
  return Effect.gen(function* () {
    yield* loadAgents({ includeRemote: false });
    const result = yield* reloadRemoteAgentsForGaps(
      planLoadedCliMultiAgentPresets(presets),
      (plans) => plans.some(teamPlanHasGaps),
      () => planLoadedCliMultiAgentPresets(presets),
    );
    return {
      plans: result.value,
      remoteCatalogRefreshAttempted: result.remoteCatalogRefreshAttempted,
    } satisfies MultiAgentPresetPlansLoadResult;
  });
}

function reloadRemoteAgentsForGaps<T>(
  value: T,
  hasGaps: (value: T) => boolean,
  replan: () => T,
) {
  return refreshRemoteCatalogForGaps(value, hasGaps, replan, {
    canAccessRemoteCatalog: () => supabaseAuthenticated,
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
