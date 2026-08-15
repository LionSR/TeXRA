import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { resolveAndResumeStream } from '@agent/runtime';
import { getExecutionStore, inspectExecutionLease } from '@agent/storage';
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
import { initializeHeadlessTranscriptSession } from '../runtime/transcriptSession';
import {
  formatInteractiveTerminalFailure,
  interactiveTerminalFailure,
} from '../runtime/terminalRequirements';
import { CliUsageError, type CliContext } from '../runtime/cliContext';

function noResumeStateMessage(id: ExecutionId): string {
  return `Execution ${id} cannot be resumed (it completed or was cleared).`;
}

function loadFailureMessage(id: ExecutionId, error: unknown): string {
  return `Could not load session ${id}: ${toErrorMessage(error)}`;
}

function leaseInspectionFailureMessage(
  id: ExecutionId,
  error: unknown,
): string {
  return `Could not check whether execution ${id} is active: ${toErrorMessage(error)}`;
}

function activeExecutionMessage(id: ExecutionId): string {
  return `Execution ${id} is active in TeXRA.`;
}

async function workflowRecoveryInputsAreDurable(
  config: Parameters<typeof executeCliWorkflowConfig>[0],
  fallbackCwd: string,
): Promise<boolean> {
  const workingDirectory = config.workingDirectory || fallbackCwd;
  const paths = [...(config.inputFiles ?? []), ...(config.contextFiles ?? [])];
  return (
    await Promise.all(
      paths.map(async (inputPath) => {
        const absolutePath = path.isAbsolute(inputPath)
          ? inputPath
          : path.resolve(workingDirectory, inputPath);
        try {
          await fs.access(absolutePath);
          return true;
        } catch {
          return false;
        }
      }),
    )
  ).every(Boolean);
}

/**
 * Continue a stored session. Funnels through the shared
 * `resolveAndResumeStream` orchestrator: a tool-use session reopens the
 * interactive chat TUI (so a usable terminal is required), while a workflow
 * run resumes headless under its persisted execution id — the same branch
 * vocabulary the extension and desktop resume paths speak.
 */
export async function runResumeExecution(
  context: CliContext,
  id: ExecutionId,
): Promise<number> {
  await initInteractiveCliPlatform({ ...context, quietLogs: true });

  const store = getExecutionStore(id);
  let config, meta;
  try {
    [config, meta] = await Promise.all([store.readConfig(), store.readMeta()]);
  } catch (error) {
    writeTextStderr(loadFailureMessage(id, error));
    return CliExitCode.AgentError;
  }
  if (!config) {
    writeTextStderr(`Execution not found: ${id}`);
    return CliExitCode.Usage;
  }
  try {
    const lease = await inspectExecutionLease(id);
    if (lease.status === 'owned' || lease.status === 'foreign') {
      writeTextStderr(activeExecutionMessage(id));
      return CliExitCode.Usage;
    }
  } catch (error) {
    writeTextStderr(leaseInspectionFailureMessage(id, error));
    return CliExitCode.AgentError;
  }
  // FK-first: the stream id stamped at registration is the reproduction
  // contract. A row without one has no persisted stream to continue.
  const streamId = meta?.streamId;
  if (!streamId) {
    writeTextStderr(noResumeStateMessage(id));
    return CliExitCode.Usage;
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
  } else {
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
  }

  // The funnel's guards need the live session planes; the TUI and the
  // headless skeleton both adopt this session rather than re-initializing.
  const { session } = await initializeHeadlessTranscriptSession();

  let exitCode: number = CliExitCode.Usage;
  let failed = false;
  let failureExitCode: CliExitCode = CliExitCode.AgentError;
  const resumed = await resolveAndResumeStream(streamId, {
    interactions: session.interactions,
    streamStatus: session.status,
    resolveResumeState: async () => ({ runState: config, executionId: id }),
    resumeToolUse: async (resume) => {
      const { runChat } = await import('../chat/tui/runChatTui');
      const result = await runChat(context, {
        initialResume: { id, resolution: resume },
      });
      exitCode = result.exitCode;
      return true;
    },
    executeWorkflow: async (
      workflowConfig,
      executionId,
      modelHandlerCompatibilityKey,
    ) => {
      const output = resumeWorkflowOutputFile(workflowConfig);
      const outputDir = resumeWorkflowOutputDirectory(workflowConfig);
      await assertOutputFileAvailable(output, context.cwd);
      await assertOutputDirAvailable(outputDir, context.cwd);
      exitCode = await executeCliWorkflowConfig(
        workflowConfig,
        buildHeadlessRunContext(context),
        {
          executionId: executionId ?? id,
          modelHandlerCompatibilityKey,
          // Honor the original run's persisted output destination.
          output,
          outputDir,
          expectedOutputFiles:
            workflowConfig.cliExpectedOutputFiles ?? undefined,
          recoveryInputIsDurable: await workflowRecoveryInputsAreDurable(
            workflowConfig,
            context.cwd,
          ),
          categoryMismatchMessage: `Execution ${id} resolved to a non workflow run.`,
        },
      );
    },
    reportNoResumableSession: () => {
      writeTextStderr(noResumeStateMessage(id));
    },
    reportFailure: (_streamId, error) => {
      failed = true;
      if (error instanceof CliUsageError) {
        failureExitCode = CliExitCode.Usage;
        writeTextStderr(error.message);
      } else {
        writeTextStderr(loadFailureMessage(id, error));
      }
    },
  });
  if (failed) return failureExitCode;
  return resumed ? exitCode : CliExitCode.Usage;
}
