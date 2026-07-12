import {
  preflightTeamAvailability,
  type TeamAvailabilityChoice,
  type TeamAvailabilityPreflightResult,
} from '@controllers/teams/TeamAvailabilityPreflight';
import { teamHostedNamesForPreflight } from '@controllers/teams/TeamRoster';

import {
  cliMultiAgentTexraHostedMissingNames,
  type CliMultiAgentPresetRunPlan,
} from './multiAgentPresets';

export interface CliTeamAvailabilityPreflightDeps {
  readonly plan: CliMultiAgentPresetRunPlan;
  readonly remoteCatalogRefreshAttempted: boolean;
  readonly canAccessRemoteCatalog: () => Promise<boolean>;
  readonly choose: (
    unavailableNames: readonly string[],
  ) => Promise<TeamAvailabilityChoice>;
  readonly signIn: () => Promise<boolean>;
  readonly refresh: () => Promise<CliMultiAgentPresetRunPlan>;
}

/** CLI host adapter for the shared team availability policy. */
export function preflightCliTeamAvailability(
  deps: CliTeamAvailabilityPreflightDeps,
): Promise<TeamAvailabilityPreflightResult<CliMultiAgentPresetRunPlan>> {
  return preflightTeamAvailability({
    initial: deps.plan,
    unresolvedNames: cliMultiAgentTexraHostedMissingNames,
    texraHostedNames: teamHostedNamesForPreflight(deps.plan.preset, [
      ...deps.plan.missingWorkflowAgents,
      ...deps.plan.missingToolUseAgents,
    ]),
    canAccessRemoteCatalog: deps.canAccessRemoteCatalog,
    choose: deps.choose,
    signIn: deps.signIn,
    refresh: deps.refresh,
    remoteCatalogRefreshAttempted: deps.remoteCatalogRefreshAttempted,
  });
}
