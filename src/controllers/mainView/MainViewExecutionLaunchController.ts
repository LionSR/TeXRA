// Local imports - team launch
import type { TeamAvailabilityChoice } from '@common/teams/TeamAvailabilityPreflight';
import {
  formatPartialTeamLaunchMessage,
  formatTeamLaunchBlockedMessage,
  formatTeamUnavailableMessage,
  formatUnknownTeamMessage,
  resolveTeamLaunch,
  TEAM_SELECTION_REQUIRED_MESSAGE,
} from '@common/teams/TeamPlan';

// Local imports - main-view execution
import { createTeamCatalogPorts } from '@controllers/mainView/teamCatalogPorts';
import {
  type MainViewExecutionPreparationResult,
  prepareMainViewExecutionRequest,
  prepareMainViewTeamExecutionRequest,
} from '@controllers/mainView/MainViewExecutionController';

// Local imports - shared types and errors
import type { MainViewExecuteMessage } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

/** Host interactions needed by the shared team-launch decision sequence. */
export interface MainViewExecutionLaunchHost {
  chooseTeamAvailability(
    unavailableNames: readonly string[],
  ): Promise<TeamAvailabilityChoice | undefined>;
  signInForRemoteAgentCatalog(): Promise<boolean>;
  showErrorMessage(message: string): Promise<void> | void;
  showInfoMessage(message: string): Promise<void> | void;
}

/**
 * Resolve an ordinary or team launch into one validated execution request.
 * Host-specific prechecks and invalid-request presentation remain with callers.
 */
export async function prepareMainViewExecutionLaunch(
  message: MainViewExecuteMessage,
  host: MainViewExecutionLaunchHost,
): Promise<MainViewExecutionPreparationResult | undefined> {
  if (message.session?.launchTarget !== 'team') {
    return prepareMainViewExecutionRequest(message);
  }

  try {
    const teamId = message.session.teamId;
    if (!teamId) {
      await host.showErrorMessage(TEAM_SELECTION_REQUIRED_MESSAGE);
      return undefined;
    }

    const resolution = await resolveTeamLaunch({
      teamId,
      ...createTeamCatalogPorts(),
      choose: (unavailableNames) =>
        host.chooseTeamAvailability(unavailableNames),
      signIn: () => host.signInForRemoteAgentCatalog(),
    });

    switch (resolution.status) {
      case 'cancelled':
        return undefined;
      case 'unknown-team':
        await host.showErrorMessage(formatUnknownTeamMessage(teamId));
        return undefined;
      case 'blocked':
        await host.showErrorMessage(
          formatTeamLaunchBlockedMessage(teamId, resolution.reason),
        );
        return undefined;
      case 'unavailable':
        await host.showErrorMessage(
          formatTeamUnavailableMessage(teamId, resolution.unavailableNames),
        );
        return undefined;
      case 'ready':
        if (resolution.partial) {
          await host.showInfoMessage(
            formatPartialTeamLaunchMessage(resolution.missingNames),
          );
        }
        return prepareMainViewTeamExecutionRequest(message, resolution.fields);
    }
  } catch (error) {
    await host.showErrorMessage(`Team launch failed: ${toErrorMessage(error)}`);
    return undefined;
  }
}
