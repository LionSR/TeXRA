// Third-party imports
import { z } from 'zod';

// Local imports - agent
import {
  getExecutionStore,
  registerExecution,
  writeTerminalStatus,
} from '@agent/storage';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import {
  getCurrentToolContexts,
  type ToolCallContext,
} from '@agent/toolUse/ToolFileInteractionContext';
import {
  registerInterruptible,
  unregisterInterruptible,
  type IInterruptible,
} from '@agent/toolUse/ToolUseAgentRegistry';
import { AgentCategory } from '@agent/core/AgentDataclass';
import { AgentConfigSchema } from '@agent/core/AgentConfig';
import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';

// Local imports - tools
import type { StreamTabId, ExecutionId } from '@shared/schemas';
import { ToolError, type ToolResult } from '@tools/result';
import { formatBashDelivery, formatBashError } from '@tools/subagentResults';
import {
  buildBashApprovalRejectedResult,
  requestBashApproval,
} from '@tools/approval/bashApproval';

// Local imports - utils
import { formatDuration } from '@utils/core';
import { generateExecutionId } from '@utils/core/executionId';
import { ensureRunDir } from '@utils/files/taskRunStorage';
import { appendTail } from '@utils/strings/appendTail';
import { executeCommand, signalProcessGroup } from '@utils/system/execUtils';
import { truncateWithEllipsis } from '@utils/text/stringUtils';

// Local file imports
import { defineTool } from './core/define';
import { createChildStream, finalizeChildStream } from './childStream';
import { parseWorkingDirectory } from './pathResolution';

const BASH_TIMEOUT_MS = 120_000; // 120 s
const BACKGROUND_OUTPUT_TAIL_CHARS = 12_000;
/** Max chars logged to the child stream tab to prevent unbounded memory growth. */
const BACKGROUND_LOG_CAP_CHARS = 200_000;
const SHELL_BACKGROUNDING_PATTERN =
  /(?:^|[\s;])nohup\b[^\n;]*(?<![>&])&(?![>&])/;
const SHELL_BACKGROUNDING_MESSAGE =
  'This command uses shell-level backgrounding (`nohup ... &`) inside a foreground bash tool call. ' +
  'Do not emulate background execution inside the shell; call the bash tool again with `run_in_background: true` and the command without `nohup` or a trailing `&`.';

const BashInputSchema = z.strictObject({
  command: z.string(),
  timeout: z
    .int()
    .min(1000)
    .max(600_000)
    .nullish()
    .describe(
      'Timeout in milliseconds (max 600,000 ms / 10 min, default 120,000 ms / 2 min).',
    ),
  run_in_background: z
    .boolean()
    .prefault(false)
    .describe(
      'Run command in background. Returns immediately with execution ID and child stream tab. Result delivered as follow-up when complete.',
    ),
});

export type BashInput = z.infer<typeof BashInputSchema>;

function usesShellLevelBackgrounding(command: string): boolean {
  return SHELL_BACKGROUNDING_PATTERN.test(command);
}

class BashBackgroundSession implements IInterruptible {
  private pid: number | undefined;
  private interrupted = false;

  setPid(pid: number): void {
    this.pid = pid;
    // If interrupt() was called before pid arrived, kill now
    if (this.interrupted) {
      signalProcessGroup(pid, 'SIGTERM');
    }
  }

  interrupt(): void {
    this.interrupted = true;
    if (this.pid) {
      signalProcessGroup(this.pid, 'SIGTERM');
    }
  }
}

export class BashTool extends defineTool({
  name: 'bash',
  description:
    'Execute shell commands directly in the workspace directory. Commands run from the project root automatically. Available environment variables: $PROJECT_DIR (workspace path), $PROJECT_NAME (project name). Returns stdout on success, throws error with stderr on failure. Use run_in_background for long-running commands.',
  schema: BashInputSchema,
}) {
  protected async execute(input: BashInput): Promise<ToolResult> {
    if (
      !input.run_in_background &&
      usesShellLevelBackgrounding(input.command)
    ) {
      throw new ToolError(SHELL_BACKGROUNDING_MESSAGE);
    }

    // Request approval before executing the command
    const approval = await requestBashApproval({ command: input.command });

    if (!approval.accepted) {
      return buildBashApprovalRejectedResult(
        input.command,
        approval.userMessage,
      );
    }

    // Signal execution starting (triggers in-progress log after approval)
    const contexts = getCurrentToolContexts();
    const callContext = contexts?.callContext;
    const runContext = contexts?.runContext;
    callContext?.onExecutionReady?.();

    const timeoutMs = input.timeout ?? BASH_TIMEOUT_MS;

    const cwd = parseWorkingDirectory(runContext?.workingDirectory);

    if (input.run_in_background) {
      return this.executeBackground(
        input.command,
        timeoutMs,
        runContext?.streamId,
        runContext?.executionId,
        runContext?.runtimeHost,
        cwd,
      );
    }

    return this.executeForeground(input.command, timeoutMs, callContext, cwd);
  }

  private async executeForeground(
    command: string,
    timeoutMs: number,
    ctx: ToolCallContext | undefined,
    cwd?: string,
  ): Promise<ToolResult> {
    const startedAt = Date.now();
    const result = await executeCommand(command, {
      cwd,
      truncate: true,
      timeout: timeoutMs,
      onStdout: ctx?.onToolOutput,
      onStderr: ctx?.onToolOutput,
    });

    if (result.timedOut) {
      const parts: string[] = [
        `Foreground command timed out after ${timeoutMs / 1000}s.`,
      ];
      if (result.stdout) parts.push(`<stdout>${result.stdout}</stdout>`);
      if (result.stderr) parts.push(`<stderr>${result.stderr}</stderr>`);
      parts.push(
        `To fix, either:\n` +
          `- Increase the timeout parameter up to 600s (600000ms): { "timeout": 600000 }\n` +
          `- Set run_in_background: true to execute asynchronously: { "run_in_background": true }\n` +
          `Do not use shell-level backgrounding such as \`nohup ... &\` inside a foreground call.`,
      );
      throw new ToolError(parts.join('\n'));
    }

    const duration = formatDuration(Date.now() - startedAt);

    if (result.success) {
      const preview = truncateWithEllipsis(command, 60);
      return {
        summary: `Executed: ${preview} (exit 0, ${duration})`,
        output: result.stdout ?? '',
      };
    }
    // Many CLI tools (including latexmk) write errors to stdout, not stderr
    const errorOutput =
      [result.stderr, result.stdout].filter(Boolean).join('\n') ||
      'No error output available';
    throw new ToolError(`Command failed (${duration}): ${errorOutput}`);
  }

  private async executeBackground(
    command: string,
    timeoutMs: number,
    parentStreamId: StreamTabId | undefined,
    parentExecutionId: ExecutionId | undefined,
    runtimeHost: AgentRuntimeHost | undefined,
    cwd?: string,
  ): Promise<ToolResult> {
    if (!parentStreamId || !runtimeHost) {
      throw new ToolError(
        'Background execution requires a parent stream runtime context.',
      );
    }

    const executionId = generateExecutionId();

    await ensureRunDir(executionId);

    const preview = truncateWithEllipsis(command, 60);

    const syntheticConfig = AgentConfigSchema.parse({
      agent: 'bash',
      instruction: command,
      agentCategory: AgentCategory.ToolUse,
    });

    await registerExecution(
      executionId,
      syntheticConfig,
      'bash',
      parentExecutionId,
      'process',
    );

    const { childStreamId, logger } = createChildStream(
      executionId,
      parentStreamId,
      {
        streamPrefix: 'bash@tool',
        streamCategory: AgentCategory.ToolUse,
        agentName: 'bash',
        description: command,
        config: syntheticConfig,
        toolName: 'bash',
        runtimeHost,
      },
    );
    let stdoutTail = '';
    let stderrTail = '';
    let loggedChars = 0;
    let logCapReached = false;
    const session = new BashBackgroundSession();
    registerInterruptible(childStreamId, session);

    const logChunk = (chunk: string, level: 'info' | 'warn'): void => {
      if (logCapReached) return;
      loggedChars += chunk.length;
      if (loggedChars > BACKGROUND_LOG_CAP_CHARS) {
        logCapReached = true;
        logger.warn(
          `[Stream log truncated at ${(BACKGROUND_LOG_CAP_CHARS / 1000).toFixed(0)}k chars — tail available in follow-up result]`,
        );
        return;
      }
      logger[level](chunk);
    };

    const startedAt = Date.now();
    const promise = executeCommand(command, {
      cwd,
      timeout: timeoutMs,
      buffer: false,
      onPid: (p) => {
        session.setPid(p);
      },
      onStdout: (chunk) => {
        stdoutTail = appendTail(
          stdoutTail,
          chunk,
          BACKGROUND_OUTPUT_TAIL_CHARS,
        );
        logChunk(chunk, 'info');
      },
      onStderr: (chunk) => {
        stderrTail = appendTail(
          stderrTail,
          chunk,
          BACKGROUND_OUTPUT_TAIL_CHARS,
        );
        logChunk(chunk, 'warn');
      },
    });

    void promise
      .then(async (result) => {
        const wallTimeMs = Date.now() - startedAt;
        const store = getExecutionStore(executionId);
        await store.writeResultMeta({
          exitCode: result.exitCode,
          wallTimeMs,
          success: result.success,
          timedOut: result.timedOut,
          command,
        });
        const terminalStatus = result.success ? 'completed' : 'error';
        await writeTerminalStatus(executionId, terminalStatus).catch(() => {});
        unregisterInterruptible(childStreamId);
        finalizeChildStream(childStreamId, executionId, logger, runtimeHost, {
          wallTimeMs,
          error: result.success
            ? undefined
            : new ToolError(
                `Background bash failed with exit code ${result.exitCode ?? 'unknown'}.`,
              ),
          autoClose: true,
        });

        const msg = formatBashDelivery(
          executionId,
          command,
          wallTimeMs,
          result,
          stdoutTail,
          stderrTail,
        );
        await store.writeReport(msg);
        ToolUseFollowUpQueue.enqueue(parentStreamId, msg);
      })
      .catch(async (err: unknown) => {
        await writeTerminalStatus(executionId, 'error').catch(() => {});
        unregisterInterruptible(childStreamId);
        finalizeChildStream(childStreamId, executionId, logger, runtimeHost, {
          error: err,
          autoClose: true,
        });

        const msg = formatBashError(executionId, command, err);
        await getExecutionStore(executionId).writeReport(msg);
        ToolUseFollowUpQueue.enqueue(parentStreamId, msg);
      });

    return {
      summary: `Launched background: ${preview}`,
      output: [
        `Command launched in background.`,
        `Execution ID: ${executionId}`,
        `Stream tab: ${childStreamId}`,
        `To wait for completion: executions tool with path=/executions/${executionId} action=wait`,
        'Result will be delivered as a follow-up message when complete.',
      ].join('\n'),
    };
  }
}
