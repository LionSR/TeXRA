import { absurd, Effect, Result, Schema, SchemaIssue } from 'effect';

import { type StartInput } from '@texra-ai/harness';
import {
  AgentCatalog,
  type StateReadFailed,
  type AgentDelegationScope,
  type WorkspaceAgentsStores,
} from '@texra-ai/harness/host';
import {
  AGENT_SOURCE,
  agentKey,
  agentKeyOf,
  agentName,
  type AgentConfig,
  Rejected,
} from '@texra-ai/harness/schemas';
import {
  formatTeamLaunchBlockedMessage,
  formatUnknownTeamMessage,
  resolveTeamLaunch,
} from '@texra/shared/teamLaunch';
import { isPastedImage } from '@texra/shared/utils/pastedImageName';
import { decodeLaunchConfig } from '@texra/controllers/session/launchConfig';
import type { HostCommand } from '@texra/shared/session/hostRequest';
import { createTeamCatalogPorts } from '@texra/controllers/mainView/teamCatalogPorts';
import { documentTaskPatch } from '@texra/agent/output/documentRecipe';
import { documentTaskOf } from '@texra/tools/documents/documentTask';
import {
  DocumentTaskOptionsSchema,
  documentTaskOptions,
} from '@texra/shared/plugins/documents';
import type { LaunchPatchSchema } from '@texra/shared/session/surface';
import { pastedImageFullPath } from '@texra/utils/files/pastedImageUtils';

type LaunchRequest = Extract<HostCommand, { kind: 'launch' }>;

/** The session's slots a launch reads: its agent selection and storage
 *  root, under which its pasted images live. */
type LaunchRoots = WorkspaceAgentsStores & { readonly storage: string };

/** Turn the launcher's selections into a decoded configuration. */
const buildLaunchConfig = Effect.fn('buildLaunchConfig')(function* (
  launch: LaunchRequest['launch'],
  instruction: string,
  agent: string,
  roots: LaunchRoots,
  team?: {
    readonly delegationAgentScope: AgentDelegationScope;
    readonly cli: { readonly teamId: string };
  },
): Effect.fn.Return<AgentConfig, Rejected | StateReadFailed, AgentCatalog> {
  // The agent decides the mode: one with a document task runs it over the
  // files; any other agent, and a team's lead, chats. An agent the catalog
  // does not know launches as a chat, whose own resolution shows the
  // agent-config banner. A failed load refuses the launch: the catalog may
  // still serve the agent, which would then run as a chat without its task.
  const workspaceAgents = (yield* AgentCatalog).workspaceAgents(roots);
  const entry = team
    ? null
    : yield* workspaceAgents.forLaunch(agent).pipe(
        Effect.catchTags({
          LaunchRefused: () => Effect.succeed(null),
          AgentCatalogLoadError: (failed) =>
            Effect.fail(new Rejected({ reason: failed.message })),
        }),
      );
  // The form lists the workspace's visible agents (`agentOptionsData`) and
  // reads the mode from the one its selection names, so a launch runs only
  // one of them. The catalog also finds an agent hidden since it was chosen
  // (or the hidden agent of a run Run again… opened the form on); the form
  // shows no agent and no mode for it, so its launch is refused.
  if (
    entry !== null &&
    !(yield* workspaceAgents.visible()).some(
      (shown) => agentKeyOf(shown) === agentKeyOf(entry),
    )
  )
    return yield* new Rejected({
      reason: `Choose an agent first: ${entry.name} is hidden from the agent selector.`,
    });
  const task = entry !== null && documentTaskOf(entry) !== null ? entry : null;
  // A task revises its input files, or reads its media alone (a recording
  // to transcribe, a scan to OCR).
  if (
    task &&
    launch.inputFiles.length === 0 &&
    launch.mediaFiles.length === 0
  ) {
    return yield* new Rejected({
      reason: 'Choose an input or media file first.',
      docsPage: 'file-management',
    });
  }

  // A task's options are the form's switches; a chat takes none.
  const optionsResult = task
    ? Schema.decodeUnknownResult(DocumentTaskOptionsSchema)(launch)
    : undefined;
  if (optionsResult !== undefined && !Result.isSuccess(optionsResult)) {
    const [issue] = SchemaIssue.makeFormatterStandardSchemaV1()(
      optionsResult.failure.issue,
    ).issues;
    const path =
      issue?.path
        ?.map((segment) =>
          String(typeof segment === 'object' ? segment.key : segment),
        )
        .join('.') || 'options';
    return yield* new Rejected({
      reason: `Invalid task options (${path}): ${issue?.message ?? 'validation failed'}`,
    });
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
  // A document task runs its agent's recipe over the files, with the
  // form's switches checked above.
  const patch = task ? documentTaskPatch(config, task, launch) : null;
  return yield* decodeLaunchConfig(patch ? { ...config, ...patch } : config);
});

/**
 * The run option an Auto-approve launch adds: its run starts with every
 * bypass on, the same state the run header's switches write, so the header
 * shows it and the user can take it back mid-run. Block still denies: the
 * policy is decided before any bypass.
 */
export function launchApprovalOptions({
  launch,
}: LaunchRequest): Pick<StartInput, 'approval'> {
  return launch.approval === 'autoApprove' ? { approval: 'autoApprove' } : {};
}

/** Both GUI hosts launch the selections carried by the requesting surface. */
export const prepareSurfaceLaunch = Effect.fn('prepareSurfaceLaunch')(
  function* (
    { launch, instruction }: LaunchRequest,
    /** The requesting session's slots and storage root, carried as data: the
     *  pasted-image paths it names are joined onto its root rather than
     *  resolved from an ambient read at this depth. */
    roots: LaunchRoots,
  ): Effect.fn.Return<AgentConfig, Rejected | StateReadFailed, AgentCatalog> {
    if (launch.launchTarget !== 'team') {
      // The form sends an empty agent or model while nothing is selected;
      // say so in the form's words rather than as a schema issue.
      if (!launch.agent || !launch.model)
        return yield* new Rejected({
          reason: 'Choose an agent and a model first.',
        });
      return yield* buildLaunchConfig(launch, instruction, launch.agent, roots);
    }
    const teamId = launch.selectedTeamId || undefined;
    if (!teamId)
      return yield* new Rejected({ reason: 'Team selection required.' });
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
        if (!launch.model)
          return yield* new Rejected({ reason: 'Choose a model first.' });
        return yield* buildLaunchConfig(
          launch,
          instruction,
          resolution.fields.agent,
          roots,
          resolution.fields,
        );
      default:
        return absurd(resolution);
    }
  },
);

/**
 * The launcher's selections that would launch `config` again, the reverse
 * of {@link buildLaunchConfig}: Run again… opens the form on them. An
 * agent its caller defined (inline) is in no catalog, so the form cannot
 * hold it and Run again… refuses.
 */
export function launchFormOf(
  config: AgentConfig,
): Effect.Effect<typeof LaunchPatchSchema.Type, Rejected> {
  if (config.agentSource === AGENT_SOURCE.INLINE)
    return Effect.fail(
      new Rejected({
        reason: `'${config.agent}' was defined by the run that started it and is not in your agents, so the form cannot run it again.`,
      }),
    );
  const teamId = config.cli?.teamId;
  return Effect.succeed({
    ...documentTaskOptions(config),
    ...(teamId
      ? { launchTarget: 'team' as const, selectedTeamId: teamId }
      : {
          launchTarget: 'agent' as const,
          // A form launch already names its agent by key.
          agent:
            config.agentSource == null
              ? config.agent
              : agentKey(config.agentSource, agentName(config.agent)),
        }),
    // Effort and mode included: the model menu offers it as itself.
    model: config.model,
    instruction: config.instruction,
    workingDirectory: config.workingDirectory ?? '',
    inputFiles: [...config.inputFiles],
    contextFiles: [...config.contextFiles],
    mediaFiles: [...config.mediaFiles],
  });
}
