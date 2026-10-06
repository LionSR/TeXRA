// Local imports - run requests
import { Effect } from 'effect';

// Local imports - team launch

// Local imports - main-view run

// Local imports - shared types and errors
import {
  Rejected,
  type StateReadFailed,
  type StateStore,
} from '@texra-ai/harness';
import {
  validateRunRequest,
  type ValidatedRunRequest,
} from '@agent/core/state/runRequests';
import {
  formatTeamLaunchBlockedMessage,
  formatUnknownTeamMessage,
  resolveTeamLaunch,
  TEAM_SELECTION_REQUIRED_MESSAGE,
} from '@common/teams/TeamPlan';
import type { HostRequest } from '@shared/session/hostRequest';
import {
  DEFAULT_TOOL_CONFIG,
  ToolConfigSchema,
  type AgentDelegationScope,
  type SessionType,
} from '@shared/schemas';
import { createTeamCatalogPorts } from '@texra/controllers/mainView/teamCatalogPorts';
import { documentTaskConfig } from '@texra/agent/output/documentRecipe';
import { pastedImageFullPath } from '@texra/utils/files/pastedImageUtils';
import { assertNever } from '@utils/core';
import { isPastedImage } from '@utils/files/pastedImageName';
import type { AgentCatalogServices } from '@texra-ai/harness';

type LaunchRequest = Extract<HostRequest, { kind: 'launch' }>;

type LaunchPreparation =
  | { valid: true; request: ValidatedRunRequest }
  | { valid: false; message: string; docsPage?: string };

/** Turn the launcher's selections into a validated run request. */
function buildLaunchRequest(
  launch: LaunchRequest['launch'],
  instruction: string,
  agent: string,
  sessionType: SessionType,
  /** The session's storage root, under which its pasted images live. */
  storageRoot: string,
  team?: {
    readonly delegationAgentScope: AgentDelegationScope;
    readonly cli: { readonly teamId: string };
  },
): LaunchPreparation {
  const task = sessionType === 'task';
  if (task && launch.inputFiles.length === 0) {
    return {
      valid: false,
      message: 'Choose an input file first.',
      docsPage: 'file-management',
    };
  }

  const toolConfigResult = task
    ? ToolConfigSchema.safeParse(launch)
    : { success: true as const, data: DEFAULT_TOOL_CONFIG };
  if (!toolConfigResult.success) {
    const issue = toolConfigResult.error.issues[0];
    const path = issue?.path.join('.') || 'toolConfig';
    return {
      valid: false,
      message: `Invalid tool configuration (${path}): ${issue?.message ?? 'validation failed'}`,
    };
  }

  const config = {
    agent,
    model: launch.model,
    instruction,
    workingDirectory: launch.workingDirectory.trim() || undefined,
    inputFiles: launch.inputFiles,
    contextFiles: launch.contextFiles,
    ...(team
      ? {
          delegationAgentScope: team.delegationAgentScope,
          cli: { teamId: team.cli.teamId },
        }
      : {}),
    // A task's output paths are implicit in the input list. Its definition
    // may still declare generated filenames (`task.outputs`).
    outputFiles: [],
    toolConfig: toolConfigResult.data,
    mediaFiles: launch.mediaFiles.map((file) =>
      isPastedImage(file) ? pastedImageFullPath(storageRoot, file) : file,
    ),
  };
  // A document task runs its agent's recipe over the files.
  const validation = validateRunRequest({
    config: task ? documentTaskConfig(config) : config,
  });

  if (!validation.valid) {
    return { valid: false, message: validation.message };
  }

  return { valid: true, request: validation.request };
}

/**
 * The run option an Auto-approve launch adds: its run starts with the
 * delegated-work bypass on, the same state the run header's "agent work"
 * switch writes, so the header shows it and the user can take it back
 * mid-run. Block still denies: the policy is decided before any bypass.
 */
export function launchApprovalOptions({ launch }: LaunchRequest): {
  approveDelegatedWork?: true;
} {
  return launch.approval === 'autoApprove'
    ? { approveDelegatedWork: true }
    : {};
}

/** Both GUI hosts launch the selections carried by the requesting surface. */
export function prepareSurfaceLaunch(
  { launch, instruction }: LaunchRequest,
  repoState: StateStore,
  /** The requesting session's storage root, carried as data: the pasted-image
   *  paths it names are joined onto it rather than resolved from an ambient
   *  read at this depth. */
  storageRoot: string,
): Effect.Effect<
  ValidatedRunRequest,
  Rejected | StateReadFailed,
  AgentCatalogServices
> {
  return Effect.gen(function* () {
    let preparation: LaunchPreparation;
    if (launch.launchTarget !== 'team') {
      // AgentConfigSchema prefaults agent/model; reject missing UI selections
      // before schema parsing so the user sees the real form problem.
      preparation =
        !launch.agent || !launch.model
          ? { valid: false, message: 'Choose an agent and a model first.' }
          : buildLaunchRequest(
              launch,
              instruction,
              launch.agent,
              launch.sessionType,
              storageRoot,
            );
    } else {
      const teamId = launch.selectedTeamId || undefined;
      if (!teamId)
        return yield* new Rejected({ reason: TEAM_SELECTION_REQUIRED_MESSAGE });
      const resolution = resolveTeamLaunch({
        teamId,
        ...(yield* createTeamCatalogPorts(repoState)),
      });
      switch (resolution.status) {
        case 'unknown-team':
          return yield* new Rejected({
            reason: formatUnknownTeamMessage(teamId),
          });
        case 'blocked':
          return yield* new Rejected({
            reason: formatTeamLaunchBlockedMessage(teamId, resolution.reason),
          });
        case 'ready':
          // The renderer's selected agent is intentionally ignored: the
          // authoritative team plan resolves both the root and delegation
          // agent list at launch time.
          preparation = !launch.model
            ? { valid: false, message: 'Choose a model first.' }
            : buildLaunchRequest(
                launch,
                instruction,
                resolution.fields.agent,
                'chat',
                storageRoot,
                resolution.fields,
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
        ...(preparation.docsPage && {
          docsPage: preparation.docsPage,
        }),
      });
    }
    return preparation.request;
  });
}
