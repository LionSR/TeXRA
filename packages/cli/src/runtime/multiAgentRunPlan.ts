import { Effect } from 'effect';

import { getCategoryAgent, loadAgents } from '@agent/index';
import { planTeamRun, planTeamRuns } from '@common/teams/TeamPlan';
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

/**
 * Resolve a preset's run plan against the loaded catalog. Headless
 * `multi-agent run` routes through this runtime helper so command entrypoints
 * cannot drift.
 */
export function loadCliMultiAgentRunPlan(
  init: MultiAgentRunPlanInit,
  repoState: StateStore,
) {
  return Effect.gen(function* () {
    yield* loadAgents();
    const preset = findTeamPreset(
      yield* readCliMultiAgentPresets(repoState),
      init.preset,
    );
    if (!preset) {
      return yield* Effect.fail(
        new CliUsageError(missingMultiAgentPresetMessage(init.preset)),
      );
    }
    return planTeamRun(preset, {
      resolveAgent: getCategoryAgent,
      agentOverride: init.agent,
    });
  });
}

export function loadCliMultiAgentPresetPlanSet(presets: readonly TeamPreset[]) {
  return Effect.gen(function* () {
    yield* loadAgents();
    return planTeamRuns(presets, { resolveAgent: getCategoryAgent });
  });
}

export function writeMissingPresetAgents(
  plan: CliMultiAgentPresetRunPlan,
): void {
  for (const warning of formatCliMultiAgentPresetRunWarnings(plan)) {
    writeTextStderr(warning);
  }
}
