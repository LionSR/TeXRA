import type { ExecutionId } from '@shared/schemas';

import { formatResumeCommand } from '../chat/tui/state/resumeHint';
import { CliExitCode } from './exitCodes';
import { initInteractiveCliPlatform } from './initPlatform';
import { writeTextStderr } from './logSinks';
import { explainNonResumable, resolveCliResumeSnapshot } from './sessionResume';
import {
  formatInteractiveTerminalFailure,
  interactiveTerminalFailure,
} from './terminalRequirements';
import type { CliContext } from './cliContext';

/**
 * Continue a stored tool-use session by reopening the interactive chat TUI.
 * Resume is interactive by nature: a resumed session returns to WAITING for
 * the user's next message, so headless callers are rejected before snapshot
 * loading.
 */
export async function runResumeExecution(
  context: CliContext,
  id: ExecutionId,
): Promise<number> {
  const terminalFailure = interactiveTerminalFailure(context);
  if (terminalFailure) {
    const commandName = context.commandName;
    const runCommand = `${commandName} run`;
    writeTextStderr(
      formatInteractiveTerminalFailure(terminalFailure, {
        headlessMessage: `Resuming continues an interactive chat session — run \`${formatResumeCommand(
          commandName,
          id,
          { approvalPolicy: context.approvalPolicy },
        )}\` in a terminal. For scripting, use \`${runCommand}\`.`,
        dumbTerminalCommand: 'resume',
        dumbTerminalOptions: {
          commandName,
          nonInteractiveFallback: `\`${runCommand}\``,
        },
      }),
    );
    return CliExitCode.Usage;
  }

  // Usually reopens the chat TUI (a non-resumable snapshot returns early
  // instead), so this is a real interactive entry point — the platform's own
  // handler (still installed here) covers signals either way, until the TUI
  // mounts and takes over (see initInteractiveCliPlatform).
  await initInteractiveCliPlatform({ ...context, quietLogs: true });

  const resolution = await resolveCliResumeSnapshot(id);
  if (resolution.kind !== 'toolUse') {
    writeTextStderr(explainNonResumable(resolution, id));
    return resolution.kind === 'load-failed'
      ? CliExitCode.AgentError
      : CliExitCode.Usage;
  }

  const { runChat } = await import('../chat/tui/runChatTui');
  const result = await runChat(context, {
    initialResume: { id, resolution },
  });
  return result.exitCode;
}
