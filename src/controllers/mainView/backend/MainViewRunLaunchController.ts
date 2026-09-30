// Local imports - run requests
import { Effect } from 'effect';
import {
  validateRunRequest,
  type ValidatedRunRequest,
} from '@agent/core/state/runRequests';
import type { SessionApprovals } from '@agent/runtime/runApprovalQueue';

// Local imports - team launch
import {
  formatTeamLaunchBlockedMessage,
  formatUnknownTeamMessage,
  resolveTeamLaunch,
  TEAM_SELECTION_REQUIRED_MESSAGE,
} from '@common/teams/TeamPlan';

// Local imports - main-view run
import { createTeamCatalogPorts } from '@controllers/mainView/teamCatalogPorts';

// Local imports - shared types and errors
import type { StateReadFailed, StateStore } from '@platform/interfaces';
import type { AgentCatalogServices } from '@platform/processRuntime';
import {
  AgentCategory,
  DEFAULT_TOOL_CONFIG,
  ToolConfigSchema,
  type AgentDelegationScope,
  type RunId,
} from '@shared/schemas';
import type { HostRequest } from '@shared/session/hostRequest';
import { Rejected } from '@shared/session/requestErrors';
import { assertNever } from '@utils/core';
import { isPastedImage } from '@utils/files/pastedImageName';
import { pastedImageFullPath } from '@utils/files/pastedImageUtils';

type LaunchRequest = Extract<HostRequest, { kind: 'launch' }>;

type LaunchPreparation =
  | { valid: true; request: ValidatedRunRequest }
  | { valid: false; message: string; docsCommand?: string };

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

/**
 * The run options an Auto-approve launch adds: its run starts with the
 * delegated-work bypass on, the same state the run header's "agent work"
 * switch writes, so the header shows it and the user can take it back
 * mid-run. `onRun` runs before the run body (AgentRunLifecycle forks it
 * with `startImmediately`) and this write is synchronous, so no approval
 * opens ahead of it. Block still denies: the policy is decided before any
 * bypass.
 */
export function launchApprovalOptions(
  { launch }: LaunchRequest,
  approvals: SessionApprovals,
): { onRun?: (runId: RunId) => Effect.Effect<void> } {
  if (launch.approval !== 'autoApprove') return {};
  return {
    onRun: (runId) =>
      Effect.sync(() => approvals.setDelegatedWorkBypasses(runId, true)),
  };
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
                AgentCategory.ToolUse,
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
        ...(preparation.docsCommand && {
          docsCommand: preparation.docsCommand,
        }),
      });
    }
    return preparation.request;
  });
}
