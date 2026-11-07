import * as path from 'node:path';

import { Effect, FileSystem, PlatformError, Result } from 'effect';

import { pathExists } from '@texra-ai/harness/node';
import {
  ensureError,
  agentKey,
  agentName,
  isTaskConfig,
  type RunId,
} from '@texra-ai/harness/schemas';
import { forkRun } from '@texra/controllers/session/runActionPolicy';
import { approvalPolicyLabel } from '@ui/copy/approvalPolicy';
import { requestErrorText } from '@ui/copy/requestErrors';

import { executeCliRun } from './run';
import {
  formatResumeCommand,
  oneShotResumeNotice,
} from '../chat/tui/state/resumeHint';
import { isLinked } from '../runtime/platform/cliService';
import { CliExitCode } from '../runtime/platform/exitCodes';
import { cliPlatform } from '../runtime/platform/initPlatform';
import { cliErrorMessage, writeTextStderr } from '../runtime/platform/logSinks';
import { buildHeadlessRunContext } from '../runtime/models/runModel';
import { resolveCliRunAgent } from '../runtime/agents';
import {
  assertOutputDirAvailable,
  assertOutputFileAvailable,
  resumeDocumentTaskOutputDirectory,
  resumeDocumentTaskOutputFile,
} from '../runtime/headless/documentTaskOutput';
import {
  formatInteractiveTerminalFailure,
  interactiveTerminalFailure,
} from '../runtime/terminal/terminalRequirements';
import { CliUsageError, type CliContext } from '../runtime/platform/cliContext';

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
const documentTaskRecoveryInputsAreDurable = Effect.fn(
  'documentTaskRecoveryInputsAreDurable',
)(function* (
  config: Parameters<typeof executeCliRun>[0],
  fallbackCwd: string,
): Effect.fn.Return<
  boolean,
  PlatformError.PlatformError,
  FileSystem.FileSystem
> {
  const fs = yield* FileSystem.FileSystem;
  const cwd = config.workingDirectory || fallbackCwd;
  const paths = [...(config.inputFiles ?? []), ...(config.contextFiles ?? [])];
  const present = yield* Effect.forEach(
    paths,
    (inputPath) => pathExists(fs, path.resolve(cwd, inputPath)),
    { concurrency: 8 },
  );
  return present.every(Boolean);
});

/**
 * Continue a stored session through the session's resume: a tool-use
 * session reopens the interactive chat TUI (so a usable terminal is
 * required), whose `/resume` calls it; a document task run resumes headless under
 * its persisted run id, in the same run skeleton as `texra run`. The chat case names the session with its persisted
 * record rather than mounting the TUI itself: `defineCliCommand` mounts it
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
  // of: the platform starts it when none runs. A document task resumes
  // headless, in this process; a service this process holds none of is
  // said, since nothing after this would say it.
  const stores = yield* cliPlatform;
  if (!isLinked(stores.service))
    writeTextStderr(`This task runs here: ${stores.service.none}`);
  const runSession = yield* stores.runSession;
  const configResult = yield* Effect.result(
    runSession.records(id).readConfig(),
  );
  if (Result.isFailure(configResult)) {
    writeTextStderr(loadFailureMessage(id, configResult.failure));
    return CliExitCode.AgentError;
  }
  const config = configResult.success;
  if (!config) {
    writeTextStderr(`Run not found: ${id}`);
    return CliExitCode.Usage;
  }
  const documentTask = isTaskConfig(config);
  if (fork && documentTask) {
    writeTextStderr(
      `Task ${id} is a document task: only a conversation can be forked.`,
    );
    return CliExitCode.Usage;
  }
  // A fork reads the source's committed rows, whoever holds it, and the
  // chat continues the new task.
  if (fork) {
    const terminalFailure = interactiveTerminalFailure(context);
    if (terminalFailure) {
      writeTextStderr(
        formatInteractiveTerminalFailure(terminalFailure, {
          headlessMessage: `Forking continues the new task in an interactive chat: run \`${context.commandName} resume ${id} --fork\` in a terminal.`,
          dumbTerminalCommand: 'resume',
          dumbTerminalOptions: { commandName: context.commandName },
        }),
      );
      return CliExitCode.Usage;
    }
    const forked = yield* Effect.result(forkRun(runSession, id, null));
    if (Result.isFailure(forked)) {
      writeTextStderr(requestErrorText(forked.failure));
      return CliExitCode.Usage;
    }
    const forkId = forked.success;
    const forkConfig = yield* runSession.records(forkId).readConfig();
    if (!forkConfig) {
      writeTextStderr(`Task ${forkId} was forked without a configuration.`);
      return CliExitCode.AgentError;
    }
    return { chat: { initialResume: { id: forkId, config: forkConfig } } };
  }
  // A run launched to run once reads no messages, so a chat over it would
  // refuse every one: once it ended, it continues as a fork. One stopped
  // mid-turn (no outcome yet) still resumes to finish it, since a fork
  // needs a finished turn. Read from the log: a service window's own view
  // fills after it opens.
  if (!documentTask) {
    const stored = yield* Effect.result(runSession.view.read([id]));
    if (Result.isFailure(stored)) {
      writeTextStderr(loadFailureMessage(id, stored.failure));
      return CliExitCode.AgentError;
    }
    const run = stored.success.runs.get(id);
    if (run?.takesFollowUps === false && run.outcome !== null) {
      writeTextStderr(oneShotResumeNotice(context.commandName, id));
      return CliExitCode.Usage;
    }
  }
  // A resumed task continues under the approval it was launched with: a
  // requested policy is said not to apply, never dropped silently. A
  // chat's new rounds take it.
  if (context.requestedApprovalPolicy !== undefined)
    writeTextStderr(
      `The requested approval policy (${approvalPolicyLabel(context.requestedApprovalPolicy)}) does not change task ${id}: it resumes under the approval it was launched with${documentTask ? '' : "; the chat's new messages take it"}.`,
    );

  // A chat resume reopens the interactive TUI, so headless callers are
  // rejected before resume-state loading. A document task resumes headless
  // and skips this gate entirely.
  if (!documentTask) {
    const terminalFailure = interactiveTerminalFailure(context);
    if (terminalFailure) {
      const commandName = context.commandName;
      const runCommand = `${commandName} run`;
      writeTextStderr(
        formatInteractiveTerminalFailure(terminalFailure, {
          headlessMessage: `Resuming continues an interactive chat session, run \`${formatResumeCommand(
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
    return {
      chat: { initialResume: { id, config } },
    };
  }

  // The launch pinned the resolved source on the record, so resume checks
  // that exact entry rather than re-resolving the bare name.
  const agent = yield* Effect.result(
    resolveCliRunAgent(
      stores,
      config.agentSource
        ? agentKey(config.agentSource, agentName(config.agent))
        : config.agent,
    ),
  );
  if (Result.isFailure(agent)) return resumeFailureExit(id, agent.failure);

  // Fast-fail on an unusable destination before the run restarts;
  // `executeCliRun` reads the same persisted `cli` block. Each
  // stored-destination reader throws on a bad persisted path, so
  // `Effect.try` keeps that refusal on the typed channel — interleaved with
  // its own probe, because the file probe's `mkdir -p` runs before the
  // directory path is ever read.
  const resumed = yield* Effect.result(
    Effect.gen(function* () {
      const outputFile = yield* Effect.try({
        try: () => resumeDocumentTaskOutputFile(config),
        catch: ensureError,
      });
      yield* assertOutputFileAvailable(outputFile, context.cwd);
      const outputDirectory = yield* Effect.try({
        try: () => resumeDocumentTaskOutputDirectory(config),
        catch: ensureError,
      });
      yield* assertOutputDirAvailable(outputDirectory, context.cwd);
      const recoveryInputIsDurable =
        yield* documentTaskRecoveryInputsAreDurable(config, context.cwd);
      // The run continues through the session's resume, inside the
      // headless run skeleton the fresh launch uses.
      return yield* executeCliRun(config, buildHeadlessRunContext(context), {
        services: stores,
        runId: id,
        recoveryInputIsDurable,
      });
    }),
  );
  if (Result.isSuccess(resumed)) return resumed.success;
  return resumeFailureExit(id, resumed.failure);
});
