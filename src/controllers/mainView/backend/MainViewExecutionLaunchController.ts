// Local imports - execution requests
import { Effect } from 'effect';
import type { ValidatedRunRequest } from '@agent/core/state/executionRequests';

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
  type MainViewRunPreparationResult,
  prepareMainViewRunRequest,
  prepareMainViewTeamRunRequest,
} from '@controllers/mainView/MainViewExecutionController';

// Local imports - shared types and errors
import type { MainViewExecuteMessage } from '@shared/schemas';
import type { HostRequest } from '@shared/session/hostRequest';
import { Cancelled, Rejected } from '@shared/session/requestErrors';
import { assertNever } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

/** Host interactions needed by the shared team-launch decision sequence. */
export interface MainViewRunLaunchHost {
  chooseTeamAvailability(
    unavailableNames: readonly string[],
  ): Promise<TeamAvailabilityChoice | undefined>;
  signInForRemoteAgentCatalog(): Promise<boolean>;
  showInfoMessage(message: string): Promise<void> | void;
}

/** Resolve an ordinary or team launch and answer refusals on the request path. */
export function prepareMainViewRunLaunch(
  message: MainViewExecuteMessage,
  host: MainViewRunLaunchHost,
): Effect.Effect<ValidatedRunRequest, Rejected | Cancelled> {
  return Effect.gen(function* () {
    let preparation: MainViewRunPreparationResult;
    let infoMessage: string | undefined;
    if (message.session?.launchTarget !== 'team') {
      preparation = prepareMainViewRunRequest(message);
    } else {
      const teamId = message.session.teamId;
      if (!teamId)
        return yield* new Rejected({ reason: TEAM_SELECTION_REQUIRED_MESSAGE });
      const resolution = yield* resolveTeamLaunch({
        teamId,
        ...createTeamCatalogPorts(),
        choose: (unavailableNames) =>
          host.chooseTeamAvailability(unavailableNames),
        signIn: () => host.signInForRemoteAgentCatalog(),
      }).pipe(
        Effect.catch((error: unknown) =>
          Effect.fail(
            new Rejected({
              reason: `Team launch failed: ${toErrorMessage(error)}`,
            }),
          ),
        ),
      );
      switch (resolution.status) {
        case 'cancelled':
          return yield* new Cancelled();
        case 'unknown-team':
          return yield* new Rejected({
            reason: formatUnknownTeamMessage(teamId),
          });
        case 'blocked':
          return yield* new Rejected({
            reason: formatTeamLaunchBlockedMessage(teamId, resolution.reason),
          });
        case 'unavailable':
          return yield* new Rejected({
            reason: formatTeamUnavailableMessage(
              teamId,
              resolution.unavailableNames,
            ),
          });
        case 'ready':
          preparation = prepareMainViewTeamRunRequest(
            message,
            resolution.fields,
          );
          if (resolution.partial)
            infoMessage = formatPartialTeamLaunchMessage(
              resolution.missingNames,
            );
          break;
        default:
          return assertNever(
            resolution,
            'Unhandled main-view team launch resolution',
          );
      }
    }
    if (!preparation.valid) {
      return yield* new Rejected({
        reason: preparation.message,
        ...(preparation.docsCommand && {
          docsCommand: preparation.docsCommand,
        }),
      });
    }
    if (infoMessage) void host.showInfoMessage(infoMessage);
    return preparation.request;
  });
}

/** Both GUI hosts launch the selections carried by the requesting surface. */
export function prepareSurfaceLaunch(
  { launch, instruction }: Extract<HostRequest, { kind: 'launch' }>,
  host: MainViewRunLaunchHost,
): Effect.Effect<ValidatedRunRequest, Rejected | Cancelled> {
  return prepareMainViewRunLaunch(
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
