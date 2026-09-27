import * as path from 'node:path';

import { Effect, FileSystem, PlatformError, Result } from 'effect';

import {
  classifyRun,
  describeFollowUpFailure,
  resumeRun,
} from '@agent/runtime';
import { getRunRecords } from '@agent/storage';
import {
  AgentCategory,
  agentKey,
  agentName,
  type RunId,
} from '@shared/schemas';
import { runHeldByProcessMessage } from '@shared/runs/runStatusDisplay';
import { ensureError } from '@utils/errors/errorMessage';
import { pathExists } from '@utils/files/fsDurability';

import { executeCliWorkflowConfig } from './workflow';
import { formatResumeCommand } from '../chat/tui/state/resumeHint';
import { CliExitCode } from '../runtime/exitCodes';
import { initCliPlatform } from '../runtime/initPlatform';
import { cliErrorMessage, writeTextStderr } from '../runtime/logSinks';
import { buildHeadlessRunContext } from '../runtime/runModel';
import { resolveCliResumeAgent } from '../runtime/agents';
import {
  assertOutputDirAvailable,
  assertOutputFileAvailable,
  resumeWorkflowOutputDirectory,
  resumeWorkflowOutputFile,
} from '../runtime/workflowOutput';
import {
  formatInteractiveTerminalFailure,
  interactiveTerminalFailure,
} from '../runtime/terminalRequirements';
import { CliUsageError, type CliContext } from '../runtime/cliContext';

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
const workflowRecoveryInputsAreDurable = Effect.fn(
  'workflowRecoveryInputsAreDurable',
)(function* (
  config: Parameters<typeof executeCliWorkflowConfig>[0],
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
    { concurrency: 'unbounded' },
  );
  return present.every(Boolean);
});

/**
 * Continue a stored session through the shared `resumeRun`: a tool-use
 * session reopens the interactive chat TUI (so a usable terminal is
 * required), whose `/resume` calls it; a workflow run resumes headless under
 * its persisted run id, in the same run skeleton as `texra run`. The chat arm names the session with its persisted
 * record rather than mounting the TUI itself: `defineCliCommand` mounts it
 * once this program has settled. This entry never suppresses the platform's
 * own signal handlers: the window below (the ownership gate, the resume)
 * still needs a graceful handler, and `runChat` hands ownership over once Ink
 * mounts.
 */
export function runResumeCommand(context: CliContext, id: RunId) {
  return Effect.gen(function* () {
    const stores = yield* initCliPlatform({ ...context, quietLogs: true });
    const session = yield* stores.session;
    const store = getRunRecords(session, id);
    const configResult = yield* Effect.result(store.readConfig());
    if (Result.isFailure(configResult)) {
      writeTextStderr(loadFailureMessage(id, configResult.failure));
      return CliExitCode.AgentError;
    }
    const config = configResult.success;
    if (!config) {
      writeTextStderr(`Run not found: ${id}`);
      return CliExitCode.Usage;
    }
    // Gate resume on ownership: a run held by any owner that is alive or cannot
    // be proven dead refuses, naming that owner.
    const classification = yield* classifyRun(id, session);
    switch (classification.kind) {
      case 'held_elsewhere':
        writeTextStderr(runHeldByProcessMessage(id, classification.owner));
        return CliExitCode.Usage;
      case 'owned_here':
        writeTextStderr(`Run ${id} is already running in this process.`);
        return CliExitCode.Usage;
      case 'unclassified':
        // `unclassified` names a durable fact that could not be read — the
        // claim, the run metadata, the latest snapshot — and nothing else.
        // Rows that do not fold are refused by the ledger's own load at the
        // open below, and come back from `resumeRun` worded
        // `unusable_checkpoint`; this arm never guesses at content it did
        // not read.
        writeTextStderr(
          `Could not read the state of run ${id}: ${classification.cause}`,
        );
        return CliExitCode.AgentError;
      case 'finished':
        writeTextStderr(describeFollowUpFailure('finished'));
        return CliExitCode.Usage;
      case 'resumable':
        break;
    }

    // Tool-use resume reopens the interactive TUI, so headless callers are
    // rejected before resume-state loading. Workflow resume runs headless and
    // skips this gate entirely.
    if (config.agentCategory === AgentCategory.ToolUse) {
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
      return { chat: { initialResume: { id, config } } };
    }

    // The launch pinned the resolved source on the record, so resume checks
    // that exact entry rather than re-resolving the bare name.
    const agent = yield* Effect.result(
      resolveCliResumeAgent(
        stores,
        config.agentSource
          ? agentKey(config.agentSource, agentName(config.agent))
          : config.agent,
      ),
    );
    if (Result.isFailure(agent)) return resumeFailureExit(id, agent.failure);

    // Fast-fail on an unusable destination before the run restarts;
    // `executeCliWorkflowConfig` reads the same persisted `cli` block. Each
    // stored-destination reader throws on a bad persisted path, so
    // `Effect.try` keeps that refusal on the typed channel — interleaved with
    // its own probe, because the file probe's `mkdir -p` runs before the
    // directory path is ever read.
    const resumed = yield* Effect.result(
      Effect.gen(function* () {
        const outputFile = yield* Effect.try({
          try: () => resumeWorkflowOutputFile(config),
          catch: ensureError,
        });
        yield* assertOutputFileAvailable(outputFile, context.cwd);
        const outputDirectory = yield* Effect.try({
          try: () => resumeWorkflowOutputDirectory(config),
          catch: ensureError,
        });
        yield* assertOutputDirAvailable(outputDirectory, context.cwd);
        const recoveryInputIsDurable = yield* workflowRecoveryInputsAreDurable(
          config,
          context.cwd,
        );
        // The run continues through the one core resume path (`resumeRun`),
        // inside the headless run skeleton the fresh launch uses.
        return yield* executeCliWorkflowConfig(
          config,
          buildHeadlessRunContext(context),
          {
            session: stores.session,
            runtime: stores.runtime,
            shutdownScope: stores.shutdownScope,
            runId: id,
            recoveryInputIsDurable,
            agentRuns: {
              // The headless run skeleton launches the persisted run through
              // the one core resume path, settling with its whole run.
              launch: (_request, options) =>
                resumeRun(id, options).pipe(
                  Effect.flatMap((resumed) => {
                    if ('failed' in resumed)
                      return Effect.fail(
                        new CliUsageError(
                          describeFollowUpFailure(resumed.failed),
                        ),
                      );
                    if (resumed.result) return Effect.succeed(resumed.result);
                    return Effect.fail(
                      new Error(`Run ${id} did not resume as a workflow.`),
                    );
                  }),
                ),
            },
          },
        );
      }),
    );
    if (Result.isSuccess(resumed)) return resumed.success;
    return resumeFailureExit(id, resumed.failure);
  });
}
