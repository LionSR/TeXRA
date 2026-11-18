import { Effect } from 'effect';

import { type StartInput } from '@texra-ai/harness';
import {
  AgentCatalog,
  type StateReadFailed,
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
import { isPastedImage } from '@texra/shared/utils/pastedImageName';
import { decodeLaunchConfig } from '@texra/controllers/session/launchConfig';
import type { HostCommand } from '@texra/shared/session/hostRequest';
import type { LaunchPatchSchema } from '@texra/shared/session/surface';
import { pastedImageFullPath } from '@texra/utils/files/pastedImageUtils';

type LaunchRequest = Extract<HostCommand, { kind: 'launch' }>;

/** The session's slots a launch reads: its agent selection and storage
 *  root, under which its pasted images live. */
type LaunchRoots = WorkspaceAgentsStores & { readonly storage: string };

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
    // The form sends an empty agent or model while nothing is selected;
    // say so in the form's words rather than as a schema issue.
    if (!launch.agent || !launch.model)
      return yield* new Rejected({
        reason: 'Choose an agent and a model first.',
      });
    // An agent the catalog does not know launches all the same: its own
    // resolution shows the agent-config banner. A failed load refuses the
    // launch.
    const workspaceAgents = (yield* AgentCatalog).workspaceAgents(roots);
    const entry = yield* workspaceAgents.forLaunch(launch.agent).pipe(
      Effect.catchTags({
        AgentNotFound: () => Effect.succeed(null),
        AgentCatalogLoadError: (failed) =>
          Effect.fail(new Rejected({ reason: failed.message })),
      }),
    );
    // The form lists the workspace's visible agents (`agentOptionsData`) and
    // reads the mode from the one its selection names, so a launch runs only
    // one of them. The catalog also finds an agent hidden since it was chosen
    // (or the hidden agent of a run Run again… opened the form on); the form
    // shows no agent for it, so its launch is refused.
    if (
      entry !== null &&
      !(yield* workspaceAgents.visible()).some(
        (shown) => agentKeyOf(shown) === agentKeyOf(entry),
      )
    )
      return yield* new Rejected({
        reason: `Choose an agent first: ${entry.name} is hidden from the agent selector.`,
      });
    return yield* decodeLaunchConfig({
      agent: launch.agent,
      model: launch.model,
      instruction,
      workingDirectory: launch.workingDirectory.trim() || undefined,
      // The form starts chats only; it shows its file lists only while open
      // on a program's proposal, so a launch carries none of them.
      inputFiles: [],
      contextFiles: [],
      outputFiles: [],
      mediaFiles: launch.mediaFiles.map((file) =>
        isPastedImage(file) ? pastedImageFullPath(roots.storage, file) : file,
      ),
    });
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
  const source = config.agentSource?.kind;
  if (source === AGENT_SOURCE.INLINE)
    return Effect.fail(
      new Rejected({
        reason: `'${config.agent}' was defined by the run that started it and is not in your agents, so the form cannot run it again.`,
      }),
    );
  return Effect.succeed({
    // A form launch already names its agent by key.
    agent:
      source === undefined
        ? config.agent
        : agentKey(source, agentName(config.agent)),
    // Effort and mode included: the model menu offers it as itself.
    model: config.model,
    instruction: config.instruction,
    workingDirectory: config.workingDirectory ?? '',
    mediaFiles: [...config.mediaFiles],
  });
}
