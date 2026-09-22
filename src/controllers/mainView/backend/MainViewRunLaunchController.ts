// Local imports - run requests
import { Effect, FileSystem } from 'effect';
import {
  validateRunRequest,
  type ValidatedRunRequest,
} from '@agent/core/state/runRequests';

// Local imports - team launch
import type {
  TeamAvailabilityChoice,
  TeamCatalogPortFailed,
} from '@common/teams/TeamAvailabilityPreflight';
import {
  formatPartialTeamLaunchMessage,
  formatTeamLaunchBlockedMessage,
  formatTeamUnavailableMessage,
  formatUnknownTeamMessage,
  resolveTeamLaunch,
  TEAM_SELECTION_REQUIRED_MESSAGE,
} from '@common/teams/TeamPlan';

// Local imports - main-view run
import type { SignInFailed } from '@common/errors/signInFailed';
import { createTeamCatalogPorts } from '@controllers/mainView/teamCatalogPorts';

// Local imports - shared types and errors
import type { MessageHost } from '@hosts/uiHosts';
import { withLogChannel } from '@logger/effectLog';
import type {
  AgentDirectories,
  StateReadFailed,
  StateStore,
} from '@platform/interfaces';
import type { GlobalStorageFs } from '@platform/rootedFs';
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
import { pastedImageFullPath } from '@utils/files/pastedImageUtils';

type LaunchRequest = Extract<HostRequest, { kind: 'launch' }>;

const CHANNEL = 'MainViewRunLaunch';

type LaunchPreparation =
  | { valid: true; request: ValidatedRunRequest }
  | { valid: false; message: string; docsCommand?: string };

/** Host interactions needed by the shared team-launch decision sequence. */
export interface MainViewRunLaunchHost {
  chooseTeamAvailability(
    unavailableNames: readonly string[],
  ): Effect.Effect<TeamAvailabilityChoice | undefined, TeamCatalogPortFailed>;
  signInForRemoteAgentCatalog(): Effect.Effect<boolean, SignInFailed>;
  showInfoMessage: MessageHost['showInfoMessage'];
}

/** Turn the launcher's selections into a validated run request. */
function buildLaunchRequest(
  launch: LaunchRequest['launch'],
  instruction: string,
  agent: string,
  agentCategory: AgentCategory,
  /** The session's storage root, under which its pasted images live. */
  storageRoot: string,
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
        isPastedImage(file) ? pastedImageFullPath(storageRoot, file) : file,
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
  workspaceState: StateStore,
  /** The requesting session's storage root, carried as data: the pasted-image
   *  paths it names are joined onto it rather than resolved from an ambient
   *  read at this depth. */
  storageRoot: string,
): Effect.Effect<
  ValidatedRunRequest,
  Rejected | Cancelled | StateReadFailed,
  GlobalStorageFs | FileSystem.FileSystem | AgentDirectories
> {
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
          : buildLaunchRequest(
              launch,
              instruction,
              agent,
              launch.sessionType,
              storageRoot,
            );
    } else {
      const teamId = launch.selectedTeamId || undefined;
      if (!teamId)
        return yield* new Rejected({ reason: TEAM_SELECTION_REQUIRED_MESSAGE });
      const resolution = yield* resolveTeamLaunch({
        teamId,
        ...(yield* createTeamCatalogPorts(workspaceState)),
        choose: (unavailableNames) =>
          host.chooseTeamAvailability(unavailableNames),
        signIn: host.signInForRemoteAgentCatalog,
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
                storageRoot,
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
    if (infoMessage) {
      // Fire-and-forget, as the `void` promise was: the launch does not wait
      // on the notice, and a host that cannot show it leaves a warn rather
      // than failing the launch.
      yield* Effect.forkDetach(
        host
          .showInfoMessage(infoMessage)
          .pipe(
            Effect.catchTag('NotificationFailed', (failure) =>
              Effect.logWarning(
                `The partial team launch notice could not be shown: ${failure.message}`,
              ).pipe(withLogChannel(CHANNEL)),
            ),
          ),
      );
    }
    return preparation.request;
  });
}
