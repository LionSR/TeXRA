import { Effect } from 'effect';

import { getCategoryAgent } from '@agent/index';
import { planTeamRun } from '@common/teams/TeamPlan';
import { findTeamPreset } from '@common/teams/TeamPresets';
import type { StateStore } from '@platform/interfaces';

import { missingTeamMessage } from './agents';
import { CliUsageError } from './cliContext';
import { readCliTeams } from './cliTeams';

interface TeamRunPlanInit {
  readonly team: string;
  readonly agent?: string;
}

/**
 * Resolve a team's run plan against the loaded catalog. Headless
 * `team run` routes through this runtime helper so command entrypoints
 * cannot drift.
 */
export function loadCliTeamRunPlan(
  init: TeamRunPlanInit,
  repoState: StateStore,
) {
  return Effect.gen(function* () {
    const team = findTeamPreset(yield* readCliTeams(repoState), init.team);
    if (!team) {
      return yield* Effect.fail(
        new CliUsageError(missingTeamMessage(init.team)),
      );
    }
    return planTeamRun(team, {
      resolveAgent: getCategoryAgent,
      agentOverride: init.agent,
    });
  });
}
