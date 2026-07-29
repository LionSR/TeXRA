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
import { assertNever } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

/** Host interactions needed by the shared team-launch decision sequence. */
export interface MainViewExecutionLaunchHost {
  chooseTeamAvailability(
    unavailableNames: readonly string[],
  ): Promise<TeamAvailabilityChoice | undefined>;
  signInForRemoteAgentCatalog(): Promise<boolean>;
}

/** Host-neutral result of resolving the launch sequence. */
export type MainViewExecutionLaunchResult =
  | {
      status: 'prepared';
      preparation: MainViewExecutionPreparationResult;
      infoMessage?: string;
    }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

/**
 * Resolve an ordinary or team launch into one validated execution request.
 * Host-specific prechecks and all user-facing presentation remain with callers.
 */
export async function prepareMainViewExecutionLaunch(
  message: MainViewExecuteMessage,
  host: MainViewExecutionLaunchHost,
): Promise<MainViewExecutionLaunchResult> {
  if (message.session?.launchTarget !== 'team') {
    return {
      status: 'prepared',
      preparation: prepareMainViewExecutionRequest(message),
    };
  }

  try {
    const teamId = message.session.teamId;
    if (!teamId) {
      return { status: 'error', message: TEAM_SELECTION_REQUIRED_MESSAGE };
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
        return { status: 'cancelled' };
      case 'unknown-team':
        return {
          status: 'error',
          message: formatUnknownTeamMessage(teamId),
        };
      case 'blocked':
        return {
          status: 'error',
          message: formatTeamLaunchBlockedMessage(teamId, resolution.reason),
        };
      case 'unavailable':
        return {
          status: 'error',
          message: formatTeamUnavailableMessage(
            teamId,
            resolution.unavailableNames,
          ),
        };
      case 'ready': {
        const preparation = prepareMainViewTeamExecutionRequest(
          message,
          resolution.fields,
        );
        return resolution.partial
          ? {
              status: 'prepared',
              preparation,
              infoMessage: formatPartialTeamLaunchMessage(
                resolution.missingNames,
              ),
            }
          : { status: 'prepared', preparation };
      }
      default:
        return assertNever(
          resolution,
          'Unhandled main-view team launch resolution',
        );
    }
  } catch (error) {
    return {
      status: 'error',
      message: `Team launch failed: ${toErrorMessage(error)}`,
    };
  }
}
