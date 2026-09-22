import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { Effect, Result } from 'effect';

import {
  classifyRun,
  describeFollowUpFailure,
  resumeRun,
  type AgentConfig,
} from '@agent/runtime';
import { getRunRecords } from '@agent/storage';
import { AgentCategory, type RunId } from '@shared/schemas';
import { runHeldByProcessMessage } from '@shared/runs/runStatusDisplay';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

import { executeCliWorkflowConfig } from './workflow';
import { formatResumeCommand } from '../chat/tui/state/resumeHint';
import { CliExitCode } from '../runtime/exitCodes';
import { installCliProcessRuntime } from '../runtime/cliProcessRuntime';
import { initCliPlatform } from '../runtime/initPlatform';
import { writeTextStderr } from '../runtime/logSinks';
import { buildHeadlessRunContext } from '../runtime/runModel';
import { resolveCliLaunchAgent } from '../runtime/agents';
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
  return `Could not load session ${id}: ${toErrorMessage(error)}`;
}

function workflowRecoveryInputsAreDurable(
  config: Parameters<typeof executeCliWorkflowConfig>[0],
  fallbackCwd: string,
): Effect.Effect<boolean> {
  const cwd = config.workingDirectory || fallbackCwd;
  const paths = [...(config.inputFiles ?? []), ...(config.contextFiles ?? [])];
  return Effect.forEach(
    paths,
    (inputPath) =>
      Effect.promise(() =>
        fs.access(path.resolve(cwd, inputPath)).then(
          () => true,
          () => false,
        ),
      ),
    { concurrency: 'unbounded' },
  ).pipe(Effect.map((checks) => checks.every(Boolean)));
}

/**
 * What the resume program decided. The chat arm carries the persisted record
 * rather than mounting the TUI itself: `runChat` installs Ink and its own
 * SIGINT/SIGTERM pair and owns the teardown, so it starts after this program
 * has settled, not inside a fiber it would outlive.
 */
type ResumeDecision =
  | { readonly kind: 'exit'; readonly code: number }
  | { readonly kind: 'chat'; readonly config: AgentConfig };

const exitWith = (code: number): ResumeDecision => ({ kind: 'exit', code });

/**
 * Continue a stored session through the shared `resumeRun`: a tool-use
 * session reopens the interactive chat TUI (so a usable terminal is
 * required), whose `/resume` calls it; a workflow run resumes headless under
 * its persisted run id.
 */
export async function runResumeCommand(
  context: CliContext,
  id: RunId,
): Promise<number> {
  // This entry never suppresses the platform's own signal handlers: the
  // window below (the ownership gate, the resume) still needs a graceful
  // handler, and `runChat` hands ownership over once Ink mounts.
  const runtime = await installCliProcessRuntime(
    context.storageRoot,
    {
      resourcesPath: context.resourcesPath,
    },
    context.minimumLogLevel,
  );

  const decision = await runtime.runPromise(
    Effect.gen(function* () {
      const stores = yield* initCliPlatform({ ...context, quietLogs: true });
      const session = yield* stores.session;
      const store = getRunRecords(session, id);
      const configResult = yield* Effect.result(store.readConfig());
      if (Result.isFailure(configResult)) {
        writeTextStderr(loadFailureMessage(id, configResult.failure));
        return exitWith(CliExitCode.AgentError);
      }
      const config = configResult.success;
      if (!config) {
        writeTextStderr(`Run not found: ${id}`);
        return exitWith(CliExitCode.Usage);
      }
      // Gate resume on ownership: a run held by any owner that is alive or cannot
      // be proven dead refuses, naming that owner.
      const classification = yield* classifyRun(id, session);
      switch (classification.kind) {
        case 'held_elsewhere':
          writeTextStderr(runHeldByProcessMessage(id, classification.owner));
          return exitWith(CliExitCode.Usage);
        case 'owned_here':
          writeTextStderr(`Run ${id} is already running in this process.`);
          return exitWith(CliExitCode.Usage);
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
          return exitWith(CliExitCode.AgentError);
        case 'finished':
          writeTextStderr(describeFollowUpFailure('finished'));
          return exitWith(CliExitCode.Usage);
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
          return exitWith(CliExitCode.Usage);
        }
        return { kind: 'chat', config } as const;
      }

      const agent = yield* Effect.result(
        resolveCliLaunchAgent(stores, config.agent, 'workflowResume'),
      );
      if (Result.isFailure(agent)) {
        const error = agent.failure;
        if (error instanceof CliUsageError) {
          writeTextStderr(error.message);
          return exitWith(CliExitCode.Usage);
        }
        writeTextStderr(loadFailureMessage(id, error));
        return exitWith(CliExitCode.AgentError);
      }

      let exitCode: number = CliExitCode.Usage;
      const resumed = yield* Effect.result(
        resumeRun(id, {
          session,
          executeWorkflow: (workflowConfig, runId, modelCompatibilityKey) =>
            Effect.gen(function* () {
              // Fast-fail on an unusable destination before the run restarts;
              // `executeCliWorkflowConfig` reads the same persisted `cli`
              // block. Each stored-destination reader throws on a bad persisted
              // path, so `Effect.try` keeps that refusal on the typed channel —
              // interleaved with its own probe, because the file probe's
              // `mkdir -p` runs before the directory path is ever read.
              const outputFile = yield* Effect.try({
                try: () => resumeWorkflowOutputFile(workflowConfig),
                catch: ensureError,
              });
              yield* assertOutputFileAvailable(outputFile, context.cwd);
              const outputDirectory = yield* Effect.try({
                try: () => resumeWorkflowOutputDirectory(workflowConfig),
                catch: ensureError,
              });
              yield* assertOutputDirAvailable(outputDirectory, context.cwd);
              const recoveryInputIsDurable =
                yield* workflowRecoveryInputsAreDurable(
                  workflowConfig,
                  context.cwd,
                );
              exitCode = yield* executeCliWorkflowConfig(
                workflowConfig,
                buildHeadlessRunContext(context),
                {
                  session: stores.session,
                  runtime: stores.runtime,
                  lifecycle: stores.lifecycle,
                  runId,
                  modelCompatibilityKey,
                  recoveryInputIsDurable,
                },
              );
            }),
        }),
      );
      if (Result.isSuccess(resumed)) {
        if ('started' in resumed.success) return exitWith(exitCode);
        writeTextStderr(describeFollowUpFailure(resumed.success.failed));
        return exitWith(CliExitCode.Usage);
      } else {
        const error = resumed.failure;
        if (error instanceof CliUsageError) {
          writeTextStderr(error.message);
          return exitWith(CliExitCode.Usage);
        }
        writeTextStderr(loadFailureMessage(id, error));
        return exitWith(CliExitCode.AgentError);
      }
    }),
  );

  if (decision.kind === 'exit') return decision.code;
  // The mount happens here, after the resume program has settled: `runChat`
  // is the interactive host entry and owns Ink, its own signal handlers and
  // its teardown.
  const { runChat } = await import('../chat/tui/runChatTui');
  return (
    await runChat(context, {
      initialResume: { id, config: decision.config },
    })
  ).exitCode;
}
