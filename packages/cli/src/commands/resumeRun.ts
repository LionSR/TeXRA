import * as path from 'node:path';

import { Effect, FileSystem, PlatformError, Result } from 'effect';

import { describeFollowUpFailure, resumeRun, runRefusal } from '@agent/runtime';
import { getRunRecords } from '@agent/storage';
import {
  agentKey,
  agentName,
  isDocumentTaskConfig,
  type RunId,
} from '@shared/schemas';
import { runHeldByProcessMessage } from '@shared/runs/runStatusDisplay';
import { ensureError } from '@utils/errors/errorMessage';
import { pathExists } from '@utils/files/fsDurability';

import { executeCliWorkflowConfig } from './workflow';
import { formatResumeCommand } from '../chat/tui/state/resumeHint';
import { describeRequestError } from '../chat/tui/state/transcript';
import { heldByService } from '../runtime/cliService';
import { CliExitCode } from '../runtime/exitCodes';
import { initCliPlatform } from '../runtime/initPlatform';
import { cliErrorMessage, writeTextStderr } from '../runtime/logSinks';
import { buildHeadlessRunContext } from '../runtime/runModel';
import { resolveCliRunAgent } from '../runtime/agents';
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

/** What `texra resume` does to the conversation besides continuing it:
 *  continue a fork of it, or reset its view first (with a handoff's text). */
export type ResumeAction =
  | { readonly kind: 'fork'; readonly at: number | null }
  | { readonly kind: 'edit'; readonly handoff: string | null };

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
    { concurrency: 8 },
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
export function runResumeCommand(
  context: CliContext,
  id: RunId,
  action?: ResumeAction,
) {
  return Effect.gen(function* () {
    const stores = yield* initCliPlatform(context);
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
    const documentTask = isDocumentTaskConfig(config);
    if (action !== undefined && documentTask) {
      writeTextStderr(
        `Task ${id} is a document task: only a conversation can be forked, reset or handed off.`,
      );
      return CliExitCode.Usage;
    }
    // A fork reads the source's committed rows, whoever holds it, and the
    // chat continues the new task.
    if (action?.kind === 'fork') {
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
      const forked = yield* Effect.result(
        session.requests.request({
          kind: 'run.fork',
          runId: id,
          at: action.at,
        }),
      );
      if (Result.isFailure(forked)) {
        writeTextStderr(describeRequestError(forked.failure));
        return CliExitCode.Usage;
      }
      if (forked.success.kind !== 'forked')
        return yield* Effect.die(
          new Error(`run.fork answered ${forked.success.kind}`),
        );
      const forkId = forked.success.runId;
      const forkConfig = yield* getRunRecords(session, forkId).readConfig();
      if (!forkConfig) {
        writeTextStderr(`Task ${forkId} was forked without a configuration.`);
        return CliExitCode.AgentError;
      }
      return { chat: { initialResume: { id: forkId, config: forkConfig } } };
    }
    // Gate resume on ownership: a run held by any owner that is alive or cannot
    // be proven dead refuses, naming that owner.
    const refusal = yield* runRefusal(id, session);
    if (refusal?.kind === 'finished') {
      writeTextStderr(describeFollowUpFailure('finished'));
      return CliExitCode.Usage;
    }
    // A conversation the service holds continues there: the chat is its
    // client, so the service stays the run's one writer.
    if (
      refusal?.kind === 'held_elsewhere' &&
      (documentTask ||
        !(yield* heldByService(context.storageRoot, refusal.owner)))
    ) {
      writeTextStderr(runHeldByProcessMessage(id, refusal.owner));
      return CliExitCode.Usage;
    }

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
        chat: {
          initialResume: {
            id,
            config,
            ...(action?.kind === 'edit' && {
              edit: { handoff: action.handoff },
            }),
          },
        },
      };
    }

    // The launch pinned the resolved source on the record, so resume checks
    // that exact entry rather than re-resolving the bare name; an inline
    // persona travels with the record.
    const agent = yield* Effect.result(
      config.agentSource === 'inline'
        ? Effect.void
        : resolveCliRunAgent(
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
              // A shutdown before the run's lane exists stops the resume through
              // its predicate; the refusal it causes reads as that abort.
              launch: (shutdown) => (_request, options) =>
                resumeRun(id, {
                  ...options,
                  isCancellationRequested: shutdown,
                }).pipe(
                  Effect.flatMap((resumed) => {
                    if ('failed' in resumed)
                      return Effect.fail(
                        shutdown()
                          ? new DOMException('Resume stopped', 'AbortError')
                          : new CliUsageError(
                              describeFollowUpFailure(resumed.failed),
                            ),
                      );
                    if (resumed.result) return Effect.succeed(resumed.result);
                    return Effect.fail(
                      new Error(`Run ${id} did not resume as a document task.`),
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
