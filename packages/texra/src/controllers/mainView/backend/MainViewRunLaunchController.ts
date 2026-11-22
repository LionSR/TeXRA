import { Effect } from 'effect';

import { type StartInput } from '@texra-ai/harness';
import { type AgentConfig, Rejected } from '@texra-ai/harness/schemas';
import { entryAgent } from '@texra/agent/entryAgent';
import { isPastedImage } from '@texra/shared/utils/pastedImageName';
import { decodeLaunchConfig } from '@texra/controllers/session/launchConfig';
import type { HostCommand } from '@texra/shared/session/hostRequest';
import { chatOf, type LaunchPatchSchema } from '@texra/shared/session/surface';
import { pastedImageFullPath } from '@texra/utils/files/pastedImageUtils';

type LaunchRequest = Extract<HostCommand, { kind: 'launch' }>;

/** The session's storage root, under which a launch's pasted images live. */
interface LaunchRoots {
  readonly storage: string;
}

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

/** Both GUI hosts launch the selections carried by the requesting surface:
 *  a conversation with the entry agent, or with the run Run again… opened
 *  the form on. */
export const prepareSurfaceLaunch = Effect.fn('prepareSurfaceLaunch')(
  function* (
    { launch, instruction }: LaunchRequest,
    /** The requesting session's storage root, carried as data: the
     *  pasted-image paths it names are joined onto its root rather than
     *  resolved from an ambient read at this depth. */
    roots: LaunchRoots,
  ): Effect.fn.Return<AgentConfig, Rejected> {
    // The form sends an empty model while nothing is selected; say so in
    // the form's words rather than as a schema issue.
    if (!launch.model)
      return yield* new Rejected({ reason: 'Choose a model first.' });
    return yield* decodeLaunchConfig({
      ...(launch.chat ?? entryAgent()),
      model: launch.model,
      instruction,
      ...(launch.skills.length > 0 && { skills: launch.skills }),
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
 * of {@link prepareSurfaceLaunch}: Run again… opens the form on them. A
 * run records its own system text and tools, so the form starts the same
 * conversation whoever wrote it.
 */
export function launchFormOf(
  config: AgentConfig,
): typeof LaunchPatchSchema.Type {
  return {
    // Effort and mode included: the model menu offers it as itself.
    model: config.model,
    instruction: config.instruction,
    skills: [...(config.skills ?? [])],
    workingDirectory: config.workingDirectory ?? '',
    mediaFiles: [...config.mediaFiles],
    chat: chatOf(config),
  };
}
