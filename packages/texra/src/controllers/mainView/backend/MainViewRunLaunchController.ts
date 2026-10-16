// Local imports - run requests
import { Effect, absurd } from 'effect';

// Local imports - team launch

// Local imports - main-view run

// Local imports - shared types and errors
import { Rejected, type StateReadFailed } from '@texra-ai/harness';
import {
  formatTeamLaunchBlockedMessage,
  formatUnknownTeamMessage,
  resolveTeamLaunch,
  TEAM_SELECTION_REQUIRED_MESSAGE,
} from '@common/teams/TeamPlan';
import { type AgentDelegationScope } from '@shared/schemas';
import { isPastedImage } from '@texra/utils/files/pastedImageName';
import {
  validateRunRequest,
  type ValidatedRunRequest,
} from '@texra/controllers/session/runRequests';
import type { SessionType } from '@texra/shared/session/surface';
import type { HostRequest } from '@texra/shared/session/hostRequest';
import { createTeamCatalogPorts } from '@texra/controllers/mainView/teamCatalogPorts';
import { documentTaskConfig } from '@texra/agent/output/documentRecipe';
import { DocumentTaskOptionsSchema } from '@texra/shared/plugins/documents';
import { pastedImageFullPath } from '@texra/utils/files/pastedImageUtils';
import type {
  AgentCatalog,
  StartInput,
  WorkspaceAgentsStores,
} from '@texra-ai/harness';

type LaunchRequest = Extract<HostRequest, { kind: 'launch' }>;

type LaunchPreparation =
  | { valid: true; request: ValidatedRunRequest }
  | { valid: false; message: string; docsPage?: string };

/** The session's slots a launch reads: its agent selection and storage
 *  root, under which its pasted images live. */
type LaunchRoots = WorkspaceAgentsStores & { readonly storage: string };

/** Turn the launcher's selections into a validated run request. */
const buildLaunchRequest = Effect.fn('buildLaunchRequest')(function* (
  launch: LaunchRequest['launch'],
  instruction: string,
  agent: string,
  sessionType: SessionType,
  roots: LaunchRoots,
  team?: {
    readonly delegationAgentScope: AgentDelegationScope;
    readonly cli: { readonly teamId: string };
  },
): Effect.fn.Return<LaunchPreparation, StateReadFailed, AgentCatalog> {
  const task = sessionType === 'task';
  if (task && launch.inputFiles.length === 0) {
    return {
      valid: false,
      message: 'Choose an input file first.',
      docsPage: 'file-management',
    };
  }

  // A task's options are the form's switches; a chat takes none.
  const optionsResult = task
    ? DocumentTaskOptionsSchema.safeParse(launch)
    : undefined;
  if (optionsResult !== undefined && !optionsResult.success) {
    const issue = optionsResult.error.issues[0];
    const path = issue?.path.join('.') || 'options';
    return {
      valid: false,
      message: `Invalid task options (${path}): ${issue?.message ?? 'validation failed'}`,
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
    // A task's output paths are implicit in the input list; the task
    // stamps the generated filenames its definition declares.
    outputFiles: [],
    mediaFiles: launch.mediaFiles.map((file) =>
      isPastedImage(file) ? pastedImageFullPath(roots.storage, file) : file,
    ),
  };
  // A document task runs its agent's recipe over the files.
  const launched = task
    ? yield* documentTaskConfig(config, roots, optionsResult?.data).pipe(
        Effect.map((built) => ({ ok: true as const, config: built })),
        Effect.catchTags({
          DocumentTaskRefused: (refused) =>
            Effect.succeed({ ok: false as const, message: refused.message }),
          AgentCatalogLoadError: (failed) =>
            Effect.succeed({ ok: false as const, message: failed.message }),
        }),
      )
    : { ok: true as const, config };
  if (!launched.ok) return { valid: false, message: launched.message };
  const validation = validateRunRequest({ config: launched.config });

  if (!validation.valid) {
    return { valid: false, message: validation.message };
  }

  return { valid: true, request: validation.request };
});

/**
 * The run option an Auto-approve launch adds: its run starts with the
 * delegated-work bypass on, the same state the run header's "agent work"
 * switch writes, so the header shows it and the user can take it back
 * mid-run. Block still denies: the policy is decided before any bypass.
 */
export function launchApprovalOptions({
  launch,
}: LaunchRequest): Pick<StartInput, 'approval'> {
  return launch.approval === 'autoApprove'
    ? { approval: { delegated: true } }
    : {};
}

/** Both GUI hosts launch the selections carried by the requesting surface. */
export function prepareSurfaceLaunch(
  { launch, instruction }: LaunchRequest,
  /** The requesting session's slots and storage root, carried as data: the
   *  pasted-image paths it names are joined onto its root rather than
   *  resolved from an ambient read at this depth. */
  roots: LaunchRoots,
): Effect.Effect<
  ValidatedRunRequest,
  Rejected | StateReadFailed,
  AgentCatalog
> {
  return Effect.gen(function* () {
    let preparation: LaunchPreparation;
    if (launch.launchTarget !== 'team') {
      // AgentConfigSchema prefaults agent/model; reject missing UI selections
      // before schema parsing so the user sees the real form problem.
      preparation =
        !launch.agent || !launch.model
          ? { valid: false, message: 'Choose an agent and a model first.' }
          : yield* buildLaunchRequest(
              launch,
              instruction,
              launch.agent,
              launch.sessionType,
              roots,
            );
    } else {
      const teamId = launch.selectedTeamId || undefined;
      if (!teamId)
        return yield* new Rejected({ reason: TEAM_SELECTION_REQUIRED_MESSAGE });
      const resolution = resolveTeamLaunch({
        teamId,
        ...(yield* createTeamCatalogPorts(roots.repoState)),
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
            : yield* buildLaunchRequest(
                launch,
                instruction,
                resolution.fields.agent,
                'chat',
                roots,
                resolution.fields,
              );
          break;
        default:
          return absurd(resolution);
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
