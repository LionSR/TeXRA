import {
  preflightTeamAvailability,
  type TeamAvailabilityChoice,
  type TeamAvailabilityPreflightResult,
} from '@common/teams/TeamAvailabilityPreflight';
import { teamHostedNamesForPreflight } from '@common/teams/TeamRoster';
import { teamTexraHostedMissingNames } from '@common/teams/TeamPlan';

import type { CliMultiAgentPresetRunPlan } from './multiAgentPresets';

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
    unresolvedNames: teamTexraHostedMissingNames,
    texraHostedNames: teamHostedNamesForPreflight(deps.plan.preset, [
      ...deps.plan.missingAgents.workflow,
      ...deps.plan.missingAgents.toolUse,
    ]),
    canAccessRemoteCatalog: deps.canAccessRemoteCatalog,
    choose: deps.choose,
    signIn: deps.signIn,
    refresh: deps.refresh,
    remoteCatalogRefreshAttempted: deps.remoteCatalogRefreshAttempted,
  });
}
