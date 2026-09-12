// Local imports - run requests
import { Effect } from 'effect';
import {
  validateRunRequest,
  type ValidatedRunRequest,
} from '@agent/core/state/runRequests';

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

// Local imports - main-view run
import { createTeamCatalogPorts } from '@controllers/mainView/teamCatalogPorts';

// Local imports - shared types and errors
import {
  AgentCategory,
  DEFAULT_TOOL_CONFIG,
  ToolConfigSchema,
  type AgentDelegationScope,
} from '@shared/schemas';
import type { HostRequest } from '@shared/session/hostRequest';
import { Cancelled, Rejected } from '@shared/session/requestErrors';
import { assertNever } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { isPastedImage } from '@utils/files/pastedImageName';
import { getPastedImageFullPath } from '@utils/files/pastedImageUtils';

type LaunchRequest = Extract<HostRequest, { kind: 'launch' }>;

type LaunchPreparation =
  | { valid: true; request: ValidatedRunRequest }
  | { valid: false; message: string; docsCommand?: string };

/** Host interactions needed by the shared team-launch decision sequence. */
export interface MainViewRunLaunchHost {
  chooseTeamAvailability(
    unavailableNames: readonly string[],
  ): Promise<TeamAvailabilityChoice | undefined>;
  signInForRemoteAgentCatalog(): Promise<boolean>;
  showInfoMessage(message: string): Promise<void> | void;
}

/** Turn the launcher's selections into a validated run request. */
function buildLaunchRequest(
  launch: LaunchRequest['launch'],
  instruction: string,
  agent: string,
  agentCategory: AgentCategory,
  team?: {
    readonly delegationAgentScope: AgentDelegationScope;
    readonly cli: { readonly multiAgentPresetId: string };
  },
): LaunchPreparation {
  const isToolUse = agentCategory === AgentCategory.ToolUse;
  if (!isToolUse && launch.inputFiles.length === 0) {
    return {
      valid: false,
      message: 'Choose an input file first.',
      docsCommand: 'file-management',
    };
  }

  const toolConfigResult = isToolUse
    ? { success: true as const, data: DEFAULT_TOOL_CONFIG }
    : ToolConfigSchema.safeParse(launch);
  if (!toolConfigResult.success) {
    const issue = toolConfigResult.error.issues[0];
    const path = issue?.path.join('.') || 'toolConfig';
    return {
      valid: false,
      message: `Invalid tool configuration (${path}): ${issue?.message ?? 'validation failed'}`,
    };
  }

  const validation = validateRunRequest({
    config: {
      agent,
      model: launch.model,
      instruction,
      workingDirectory: launch.workingDirectory.trim() || undefined,
      inputFiles: launch.inputFiles,
      contextFiles: launch.contextFiles,
      agentCategory,
      ...(team
        ? {
            delegationAgentScope: team.delegationAgentScope,
            cli: { multiAgentPresetId: team.cli.multiAgentPresetId },
          }
        : {}),
      // Workflow output paths are implicit in the input list. Agent settings
      // may still declare generated filenames later during prompt rendering.
      outputFiles: [],
      toolConfig: toolConfigResult.data,
      mediaFiles: launch.mediaFiles.map((file) =>
        isPastedImage(file) ? getPastedImageFullPath(file) : file,
      ),
    },
  });

  if (!validation.valid) {
    return { valid: false, message: validation.message };
  }

  return { valid: true, request: validation.request };
}

/** Both GUI hosts launch the selections carried by the requesting surface. */
export function prepareSurfaceLaunch(
  { launch, instruction }: LaunchRequest,
  host: MainViewRunLaunchHost,
): Effect.Effect<ValidatedRunRequest, Rejected | Cancelled> {
  return Effect.gen(function* () {
    let preparation: LaunchPreparation;
    let infoMessage: string | undefined;
    if (launch.launchTarget !== 'team') {
      // AgentConfigSchema prefaults agent/model; reject missing UI selections
      // before schema parsing so the user sees the real form problem.
      const agent = launch.agent[launch.sessionType];
      preparation =
        !agent || !launch.model
          ? {
              valid: false,
              message: 'Choose an agent, a model, and a run type first.',
            }
          : buildLaunchRequest(launch, instruction, agent, launch.sessionType);
    } else {
      const teamId = launch.selectedTeamId || undefined;
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
          // The renderer's selected agent is intentionally ignored: the
          // authoritative team plan resolves both the root and delegation
          // roster at launch time.
          preparation = !launch.model
            ? { valid: false, message: 'Choose a model first.' }
            : buildLaunchRequest(
                launch,
                instruction,
                resolution.fields.agent,
                AgentCategory.ToolUse,
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
