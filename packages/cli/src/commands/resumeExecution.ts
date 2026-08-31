import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  classifyRun,
  describeFollowUpFailure,
  resumeRun,
} from '@agent/runtime';
import { executionHeldMessage, getExecutionStore } from '@agent/storage';
import { AgentCategory, type ExecutionId } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

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

function loadFailureMessage(id: ExecutionId, error: unknown): string {
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
 * its persisted execution id.
 */
export async function runResumeExecution(
  context: CliContext,
  id: ExecutionId,
): Promise<number> {
  await initInteractiveCliPlatform({ ...context, quietLogs: true });

  const store = getExecutionStore(id);
  let config;
  try {
    config = await store.readConfig();
  } catch (error) {
    writeTextStderr(loadFailureMessage(id, error));
    return CliExitCode.AgentError;
  }
  if (!config) {
    writeTextStderr(`Execution not found: ${id}`);
    return CliExitCode.Usage;
  }
  // Gate resume on ownership: a run held by any owner that is alive or cannot
  // be proven dead refuses, naming that owner.
  const classification = await classifyRun(id);
  switch (classification.kind) {
    case 'held_elsewhere':
      writeTextStderr(executionHeldMessage(id, classification.owner));
      return CliExitCode.Usage;
    case 'owned_here':
      writeTextStderr(`Execution ${id} is already running in this process.`);
      return CliExitCode.Usage;
    case 'unclassified':
      writeTextStderr(
        `Could not read the state of execution ${id}: ${classification.cause}`,
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
    const { runChat } = await import('../chat/tui/runChatTui');
    return (await runChat(context, { initialResume: { id, config } })).exitCode;
  }

  try {
    await resolveCliLaunchAgent(config.agent, 'run');
  } catch (error) {
    if (error instanceof CliUsageError) {
      writeTextStderr(error.message);
      return CliExitCode.Usage;
    }
    writeTextStderr(loadFailureMessage(id, error));
    return CliExitCode.AgentError;
  }

  // `resumeRun`'s guards need the live session planes; the headless skeleton
  // adopts this session rather than re-initializing.
  const { session } = await initializeCliTranscriptSession();
  let exitCode: number = CliExitCode.Usage;
  try {
    const result = await resumeRun(id, {
      session,
      executeWorkflow: async (
        workflowConfig,
        executionId,
        modelHandlerCompatibilityKey,
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
        exitCode = await executeCliWorkflowConfig(
          workflowConfig,
          buildHeadlessRunContext(context),
          {
            executionId,
            modelHandlerCompatibilityKey,
            recoveryInputIsDurable: await workflowRecoveryInputsAreDurable(
              workflowConfig,
              context.cwd,
            ),
            categoryMismatchMessage: `Execution ${id} resolved to a non workflow run.`,
          },
        );
      },
    });
    if ('started' in result) return exitCode;
    writeTextStderr(describeFollowUpFailure(result.failed));
    return CliExitCode.Usage;
  } catch (error) {
    if (error instanceof CliUsageError) {
      writeTextStderr(error.message);
      return CliExitCode.Usage;
    }
    writeTextStderr(loadFailureMessage(id, error));
    return CliExitCode.AgentError;
  }
}
