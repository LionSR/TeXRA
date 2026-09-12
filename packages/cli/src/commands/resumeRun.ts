import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { Effect, Result } from 'effect';

import {
  classifyRun,
  describeFollowUpFailure,
  resumeRun,
} from '@agent/runtime';
import { runLeaseHeldMessage, getRunRecords } from '@agent/storage';
import { effectRuntime } from '@platform/processRuntime';
import { AgentCategory, type RunId } from '@shared/schemas';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

import { executeCliWorkflowConfig } from './workflow';
import { formatResumeCommand } from '../chat/tui/state/resumeHint';
import { CliExitCode } from '../runtime/exitCodes';
import { initInteractiveCliPlatform } from '../runtime/initPlatform';
import { writeTextStderr } from '../runtime/logSinks';
import { buildHeadlessRunContext } from '../runtime/runModel';
import { resolveCliLaunchAgent } from '../runtime/agents';
import {
  assertOutputDirAvailable,
  assertOutputFileAvailable,
  resumeWorkflowOutputDirectory,
  resumeWorkflowOutputFile,
} from '../runtime/workflowOutput';
import { initializeCliTranscriptSession } from '../runtime/transcriptSession';
import {
  formatInteractiveTerminalFailure,
  interactiveTerminalFailure,
} from '../runtime/terminalRequirements';
import { CliUsageError, type CliContext } from '../runtime/cliContext';

function loadFailureMessage(id: RunId, error: unknown): string {
  return `Could not load session ${id}: ${toErrorMessage(error)}`;
}

async function workflowRecoveryInputsAreDurable(
  config: Parameters<typeof executeCliWorkflowConfig>[0],
  fallbackCwd: string,
): Promise<boolean> {
  const cwd = config.workingDirectory || fallbackCwd;
  const paths = [...(config.inputFiles ?? []), ...(config.contextFiles ?? [])];
  const checks = await Promise.all(
    paths.map((inputPath) =>
      fs.access(path.resolve(cwd, inputPath)).then(
        () => true,
        () => false,
      ),
    ),
  );
  return checks.every(Boolean);
}

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
  const stores = await initInteractiveCliPlatform({
    ...context,
    quietLogs: true,
  });

  const session = await initializeCliTranscriptSession(stores);
  return effectRuntime().runPromise(
    Effect.gen(function* () {
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
          writeTextStderr(runLeaseHeldMessage(id, classification.owner));
          return CliExitCode.Usage;
        case 'owned_here':
          writeTextStderr(`Run ${id} is already running in this process.`);
          return CliExitCode.Usage;
        case 'unclassified':
          // `unclassified` names a durable fact that could not be read — the
          // lease, the run metadata, the latest snapshot — and nothing else.
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
        return yield* Effect.tryPromise({
          try: async () => {
            const { runChat } = await import('../chat/tui/runChatTui');
            return (await runChat(context, { initialResume: { id, config } }))
              .exitCode;
          },
          catch: ensureError,
        });
      }

      const agent = yield* Effect.result(
        Effect.tryPromise({
          try: () => resolveCliLaunchAgent(config.agent, 'workflowResume'),
          catch: ensureError,
        }),
      );
      if (Result.isFailure(agent)) {
        const error = agent.failure;
        if (error instanceof CliUsageError) {
          writeTextStderr(error.message);
          return CliExitCode.Usage;
        }
        writeTextStderr(loadFailureMessage(id, error));
        return CliExitCode.AgentError;
      }

      let exitCode: number = CliExitCode.Usage;
      const resumed = yield* Effect.result(
        resumeRun(id, {
          session,
          executeWorkflow: async (
            workflowConfig,
            runId,
            modelCompatibilityKey,
          ) => {
            // Fast-fail on an unusable destination before the run restarts;
            // `executeCliWorkflowConfig` reads the same persisted `cli` block.
            await assertOutputFileAvailable(
              resumeWorkflowOutputFile(workflowConfig),
              context.cwd,
            );
            await assertOutputDirAvailable(
              resumeWorkflowOutputDirectory(workflowConfig),
              context.cwd,
            );
            exitCode = await effectRuntime().runPromise(
              executeCliWorkflowConfig(
                workflowConfig,
                buildHeadlessRunContext(context),
                {
                  runId,
                  modelCompatibilityKey,
                  recoveryInputIsDurable:
                    await workflowRecoveryInputsAreDurable(
                      workflowConfig,
                      context.cwd,
                    ),
                },
              ),
            );
          },
        }),
      );
      if (Result.isSuccess(resumed)) {
        if ('started' in resumed.success) return exitCode;
        writeTextStderr(describeFollowUpFailure(resumed.success.failed));
        return CliExitCode.Usage;
      } else {
        const error = resumed.failure;
        if (error instanceof CliUsageError) {
          writeTextStderr(error.message);
          return CliExitCode.Usage;
        }
        writeTextStderr(loadFailureMessage(id, error));
        return CliExitCode.AgentError;
      }
    }),
  );
}
