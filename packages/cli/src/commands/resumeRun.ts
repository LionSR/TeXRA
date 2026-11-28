import * as path from 'node:path';

import { Effect, FileSystem, PlatformError, Result } from 'effect';

import { pathExists } from '@texra-ai/worldline/node';
import { programOf, type RunId } from '@texra-ai/worldline/schemas';
import { forkRun } from '@texra/controllers/session/runActionPolicy';
import { approvalPolicyLabel } from '@ui/copy/approvalPolicy';
import { requestErrorText } from '@ui/copy/requestErrors';
import { runsHereOnlyMessage } from '@ui/copy/sessionStore';

import { executeCliRun } from './run';
import {
  formatResumeCommand,
  oneShotResumeNotice,
} from '../runtime/resumeCommand';
import { taskNotFoundText } from '../runtime/history';
import { CliExitCode } from '../runtime/platform/exitCodes';
import { cliPlatform } from '../runtime/platform/initPlatform';
import { cliErrorMessage, writeTextStderr } from '../runtime/platform/logSinks';
import { interactiveTerminalRejection } from '../runtime/terminal/terminalRequirements';
import {
  CliUsageError,
  failUsage,
  type CliContext,
} from '../runtime/platform/cliContext';

function loadFailureMessage(id: RunId, error: unknown): string {
  return `Could not load session ${id}: ${cliErrorMessage(error)}`;
}

/** Report a failed resume step: a usage refusal names itself, any other
 *  failure reads as a session that could not load. */
function resumeFailureExit(id: RunId, error: unknown): number {
  if (error instanceof CliUsageError) {
    writeTextStderr(error.message);
    return CliExitCode.Usage;
  }
  writeTextStderr(loadFailureMessage(id, error));
  return CliExitCode.AgentError;
}

/** Every recorded input and context file is still there: an absent path
 *  (ENOENT or ENOTDIR) means "not durable"; any other failure fails the
 *  resume instead of reading as absent. */
const recoveryInputsAreDurable = Effect.fn('recoveryInputsAreDurable')(
  function* (
    config: Parameters<typeof executeCliRun>[0],
    fallbackCwd: string,
  ): Effect.fn.Return<
    boolean,
    PlatformError.PlatformError,
    FileSystem.FileSystem
  > {
    const fs = yield* FileSystem.FileSystem;
    const cwd = config.workingDirectory || fallbackCwd;
    const paths = [
      ...(config.inputFiles ?? []),
      ...(config.contextFiles ?? []),
    ];
    const present = yield* Effect.forEach(
      paths,
      (inputPath) => pathExists(fs, path.resolve(cwd, inputPath)),
      { concurrency: 8 },
    );
    return present.every(Boolean);
  },
);

/**
 * Continue a stored session through the session's resume: a tool-use
 * session reopens the interactive chat TUI (so a usable terminal is
 * required), whose `/resume` calls it; a program run resumes headless under
 * its persisted run id, in the same run skeleton as `texra run`. The chat case names the session with its persisted
 * record rather than mounting the TUI itself: `cliCommand`'s launch mounts it
 * once this program has finished. This entry never suppresses the platform's
 * own signal handlers: the window below (the ownership gate, the resume)
 * still needs a graceful handler, and `runChat` hands ownership over once Ink
 * mounts.
 */
export const runResumeCommand = Effect.fn('runResumeCommand')(function* (
  context: CliContext,
  id: RunId,
  fork = false,
) {
  // A conversation continues in the service, which every chat is a client
  // of: the platform starts it when none runs. A program run resumes
  // headless, in this process; a service this process holds none of is
  // said, since nothing after this would say it.
  const stores = yield* cliPlatform;
  if (Result.isFailure(stores.service))
    writeTextStderr(
      runsHereOnlyMessage('terminal', stores.service.failure.message),
    );
  const runSession = yield* stores.runSession;
  const configResult = yield* Effect.result(runSession.records(id).readConfig);
  if (Result.isFailure(configResult))
    return resumeFailureExit(id, configResult.failure);
  const config = configResult.success;
  if (!config) {
    return yield* failUsage(taskNotFoundText(id, context.cwd));
  }
  const program = programOf(config) !== null;
  // A fork reads the source's committed rows, whoever holds it, and the
  // chat continues the new task.
  if (fork) {
    const terminalRejection = interactiveTerminalRejection(context, 'resume', {
      headlessMessage: `Forking continues the new task in an interactive chat: run \`${context.commandName} resume ${id} --fork\` in a terminal.`,
    });
    if (terminalRejection) return yield* failUsage(terminalRejection);
    const forked = yield* Effect.result(forkRun(runSession, id));
    if (Result.isFailure(forked)) {
      return yield* failUsage(requestErrorText(forked.failure));
    }
    const forkId = forked.success;
    const forkConfig = yield* runSession.records(forkId).readConfig;
    if (!forkConfig) {
      writeTextStderr(`Task ${forkId} was forked without a configuration.`);
      return CliExitCode.AgentError;
    }
    return { chat: { initialResume: { id: forkId, config: forkConfig } } };
  }
  // An ended one-shot run continues as a fork (`oneShotResumeNotice`).
  // Read from the log: a service window's own view fills after it opens.
  if (!program) {
    const stored = yield* Effect.result(runSession.view.read([id]));
    if (Result.isFailure(stored)) return resumeFailureExit(id, stored.failure);
    const oneShot = oneShotResumeNotice(
      context.commandName,
      id,
      stored.success.runs.get(id),
    );
    if (oneShot !== undefined) {
      return yield* failUsage(oneShot);
    }
  }
  // A resumed task continues under the approval it was launched with: a
  // requested policy is said not to apply, never dropped silently. A
  // chat's new rounds take it.
  if (context.requestedApprovalPolicy !== undefined)
    writeTextStderr(
      `Note: task ${id} resumes with its original approval policy (not ${approvalPolicyLabel(context.requestedApprovalPolicy)})${program ? '' : '; new messages use the requested policy'}.`,
    );

  // A chat resume reopens the interactive TUI, so headless callers are
  // rejected before resume-state loading. A program run resumes headless
  // and skips this gate entirely.
  if (!program) {
    const runCommand = `${context.commandName} run`;
    const terminalRejection = interactiveTerminalRejection(context, 'resume', {
      headlessMessage: `Resuming opens an interactive chat; run \`${formatResumeCommand(
        context.commandName,
        id,
        { approvalPolicy: context.approvalPolicy },
      )}\` in a terminal. For scripting, use \`${runCommand}\`.`,
      nonInteractiveFallback: `\`${runCommand}\``,
    });
    if (terminalRejection) return yield* failUsage(terminalRejection);
    return {
      chat: { initialResume: { id, config } },
    };
  }

  const resumed = yield* Effect.result(
    Effect.gen(function* () {
      const recoveryInputIsDurable = yield* recoveryInputsAreDurable(
        config,
        context.cwd,
      );
      // The run continues through the session's resume, inside the
      // headless run skeleton the fresh launch uses.
      return yield* executeCliRun(config, context, {
        services: stores,
        runId: id,
        recoveryInputIsDurable,
      });
    }),
  );
  if (Result.isSuccess(resumed)) return resumed.success;
  return resumeFailureExit(id, resumed.failure);
});
