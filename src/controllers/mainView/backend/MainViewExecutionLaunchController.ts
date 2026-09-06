// Local imports - execution requests
import type { ValidatedExecutionRequest } from '@agent/core/state/executionRequests';

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
import type { HostRequest } from '@shared/session/hostRequest';
import { Cancelled, Rejected } from '@shared/session/requestErrors';
import { assertNever } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

/** Host interactions needed by the shared team-launch decision sequence. */
export interface MainViewExecutionLaunchHost {
  chooseTeamAvailability(
    unavailableNames: readonly string[],
  ): Promise<TeamAvailabilityChoice | undefined>;
  signInForRemoteAgentCatalog(): Promise<boolean>;
  showInfoMessage(message: string): Promise<void> | void;
}

/** Resolve an ordinary or team launch and answer refusals on the request path. */
export async function prepareMainViewExecutionLaunch(
  message: MainViewExecuteMessage,
  host: MainViewExecutionLaunchHost,
): Promise<ValidatedExecutionRequest> {
  let preparation: MainViewExecutionPreparationResult;
  let infoMessage: string | undefined;
  if (message.session?.launchTarget !== 'team') {
    preparation = prepareMainViewExecutionRequest(message);
  } else {
    const teamId = message.session.teamId;
    if (!teamId)
      throw new Rejected({ reason: TEAM_SELECTION_REQUIRED_MESSAGE });
    const resolution = await resolveTeamLaunch({
      teamId,
      ...createTeamCatalogPorts(),
      choose: (unavailableNames) =>
        host.chooseTeamAvailability(unavailableNames),
      signIn: () => host.signInForRemoteAgentCatalog(),
    }).catch((error: unknown) => {
      throw new Rejected({
        reason: `Team launch failed: ${toErrorMessage(error)}`,
      });
    });
    switch (resolution.status) {
      case 'cancelled':
        throw new Cancelled();
      case 'unknown-team':
        throw new Rejected({ reason: formatUnknownTeamMessage(teamId) });
      case 'blocked':
        throw new Rejected({
          reason: formatTeamLaunchBlockedMessage(teamId, resolution.reason),
        });
      case 'unavailable':
        throw new Rejected({
          reason: formatTeamUnavailableMessage(
            teamId,
            resolution.unavailableNames,
          ),
        });
      case 'ready':
        preparation = prepareMainViewTeamExecutionRequest(
          message,
          resolution.fields,
        );
        if (resolution.partial)
          infoMessage = formatPartialTeamLaunchMessage(resolution.missingNames);
        break;
      default:
        return assertNever(
          resolution,
          'Unhandled main-view team launch resolution',
        );
    }
  }
  if (!preparation.valid) {
    throw new Rejected({
      reason: preparation.message,
      ...(preparation.docsCommand && { docsCommand: preparation.docsCommand }),
    });
  }
  if (infoMessage) void host.showInfoMessage(infoMessage);
  return preparation.request;
}

/** Both GUI hosts launch the selections carried by the requesting surface. */
export function prepareSurfaceLaunch(
  { launch, instruction }: Extract<HostRequest, { kind: 'launch' }>,
  host: MainViewExecutionLaunchHost,
): Promise<ValidatedExecutionRequest> {
  return prepareMainViewExecutionLaunch(
    {
      agent: launch.agent[launch.sessionType],
      model: launch.model,
      instruction,
      agentCategory: launch.sessionType,
      files: {
        inputFiles: launch.inputFiles,
        contextFiles: launch.contextFiles,
        mediaFiles: launch.mediaFiles,
      },
      session: {
        launchTarget: launch.launchTarget,
        teamId: launch.selectedTeamId || undefined,
        workingDirectory: launch.workingDirectory.trim() || undefined,
      },
      toolConfig: launch,
    },
    host,
  );
}
