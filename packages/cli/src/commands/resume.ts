import type { ExecutionId } from '@shared/schemas';

import { CliExitCode } from '../runtime/exitCodes';
import { parseCliHistoryId } from '../runtime/history';
import { initCliPlatform } from '../runtime/initPlatform';
import { writeTextStderr } from '../runtime/logSinks';
import {
  explainNonResumable,
  resolveCliResumeSnapshot,
} from '../runtime/sessionResume';

import { defineCliCommand } from './_helpers/defineCliCommand';
import { GLOBAL_ARGS } from './_helpers/globalArgs';

import type { CliContext } from '../runtime/cliContext';

/**
 * `texra --resume <id>` continues (resumes) a stored tool-use session by
 * reopening the interactive chat TUI, which rehydrates the prior transcript and
 * continues the suspended flow.
 *
 * Resume is interactive by nature: a resumed tool-use session returns to
 * WAITING for the user's next message, so there is no meaningful non-interactive
 * continuation without an input channel — a headless run would simply block at
 * the WAIT node. Headless callers are therefore pointed at `texra run`.
 */
export async function runResumeExecution(
  context: CliContext,
  id: ExecutionId,
): Promise<number> {
  await initCliPlatform({ ...context, quietLogs: true });

  // Resolve the stored session up front so we (a) fail fast with a clear
  // message for non-resumable ids (workflow / missing / no live snapshot) and
  // (b) reopen the TUI on the SAVED model/agent rather than the current chat
  // defaults — those could be unavailable while the saved model is still
  // runnable, which would otherwise fail resume for the wrong reason.
  const resolution = await resolveCliResumeSnapshot(id);
  if (resolution.kind !== 'toolUse') {
    writeTextStderr(explainNonResumable(resolution, id));
    return CliExitCode.Usage;
  }

  const headless = context.mode === 'headless' || context.stdoutIsTty !== true;
  if (headless) {
    // A resumed tool-use session goes back to WAITING for the next message;
    // headless has no input channel to provide one, so continuing here would
    // block forever. Mirror runChat's non-TTY guidance instead of hanging.
    writeTextStderr(
      `Resuming continues an interactive chat session — run \`texra --resume ${id}\` in a terminal. For scripting, use \`texra run\`.`,
    );
    return CliExitCode.Usage;
  }

  const { runChat } = await import('../chat/tui/runChatTui');
  const result = await runChat(context, {
    resumeExecutionId: id,
    agentOverride: resolution.config.agent,
    modelOverride: resolution.config.model,
  });
  return result.exitCode;
}

export const resumeCommand = defineCliCommand({
  meta: {
    name: 'resume',
    description: 'Continue (resume) a stored tool-use session',
  },
  args: {
    ...GLOBAL_ARGS,
    id: {
      type: 'positional',
      required: true,
      description: 'Execution id from `texra history list`',
    },
  },
  run: (context, ctx) => {
    const id = parseCliHistoryId(ctx.args.id);
    if (!id) {
      writeTextStderr(`Invalid execution id: ${ctx.args.id}`);
      return Promise.resolve(CliExitCode.Usage);
    }
    return runResumeExecution(context, id);
  },
});
