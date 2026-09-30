import { Effect } from 'effect';

import { getCategoryAgent } from '@agent/index';
import { planTeamRun } from '@common/teams/TeamPlan';
import { findTeamPreset } from '@common/teams/TeamPresets';
import type { StateStore } from '@platform/interfaces';

import { missingTeamMessage } from './agents';
import { CliUsageError } from './cliContext';
import { writeTextStderr } from './logSinks';
import {
  formatCliTeamRunWarnings,
  readCliTeams,
  type CliTeamRunPlan,
} from './cliTeams';

interface TeamRunPlanInit {
  readonly preset: string;
  readonly agent?: string;
}

/**
 * Resolve a preset's run plan against the loaded catalog. Headless
 * `team run` routes through this runtime helper so command entrypoints
 * cannot drift.
 */
export function loadCliTeamRunPlan(
  init: TeamRunPlanInit,
  repoState: StateStore,
) {
  return Effect.gen(function* () {
    const preset = findTeamPreset(yield* readCliTeams(repoState), init.preset);
    if (!preset) {
      return yield* Effect.fail(
        new CliUsageError(missingTeamMessage(init.preset)),
      );
    }
    return planTeamRun(preset, {
      resolveAgent: getCategoryAgent,
      agentOverride: init.agent,
    });
  });
}

export function writeMissingPresetAgents(plan: CliTeamRunPlan): void {
  for (const warning of formatCliTeamRunWarnings(plan)) {
    writeTextStderr(warning);
  }
}
