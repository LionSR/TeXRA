// Third-party imports
import { z } from 'zod';

// Local imports - agent
import {
  getExecutionStore,
  registerExecution,
  writeTerminalStatus,
} from '@agent/storage';
import { getCurrentToolFileInteractionContext } from '@agent/toolUse/ToolFileInteractionContext';
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
import { executeCommand, signalProcessGroup } from '@utils/system/execUtils';
import { truncateWithEllipsis } from '@utils/text/stringUtils';

// Local file imports
import { defineTool } from './core/define';
import { createChildStream, finalizeChildStream } from './childStream';

const BASH_TIMEOUT_MS = 120_000; // 120 s

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

class BashBackgroundSession implements IInterruptible {
  private pid: number | undefined;

  setPid(pid: number): void {
    this.pid = pid;
  }

  interrupt(): void {
    if (!this.pid) return;
    signalProcessGroup(this.pid, 'SIGTERM');
  }
}

export class BashTool extends defineTool({
  name: 'bash',
  description:
    'Execute shell commands directly in the workspace directory. Commands run from the project root automatically. Available environment variables: $PROJECT_DIR (workspace path), $PROJECT_NAME (project name). Returns stdout on success, throws error with stderr on failure. Use run_in_background for long-running commands.',
  schema: BashInputSchema,
}) {
  protected async execute(input: BashInput): Promise<ToolResult> {
    // Request approval before executing the command
    const approval = await requestBashApproval({ command: input.command });

    if (!approval.accepted) {
      return buildBashApprovalRejectedResult(
        input.command,
        approval.userMessage,
      );
    }

    // Signal execution starting (triggers in-progress log after approval)
    const ctx = getCurrentToolFileInteractionContext();
    ctx?.onExecutionReady?.();

    const timeoutMs = input.timeout ?? BASH_TIMEOUT_MS;

    if (input.run_in_background) {
      return this.executeBackground(
        input.command,
        timeoutMs,
        ctx?.streamId,
        ctx?.executionId,
      );
    }

    return this.executeForeground(input.command, timeoutMs, ctx);
  }

  private async executeForeground(
    command: string,
    timeoutMs: number,
    ctx: ReturnType<typeof getCurrentToolFileInteractionContext>,
  ): Promise<ToolResult> {
    const startedAt = Date.now();
    const result = await executeCommand(command, {
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
          `- Set run_in_background: true to execute asynchronously: { "run_in_background": true }`,
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
  ): Promise<ToolResult> {
    if (!parentStreamId) {
      throw new ToolError(
        'Background execution requires a parent stream context.',
      );
    }

    const executionId = generateExecutionId();

    await ensureRunDir(executionId);

    const preview = truncateWithEllipsis(command, 60);

    const syntheticConfig = AgentConfigSchema.parse({
      agent: 'bash',
      instruction: command,
    });

    try {
      await registerExecution(
        executionId,
        syntheticConfig,
        'bash',
        parentExecutionId,
        'toolUse',
      );
    } catch {
      throw new ToolError('Failed to register background execution.');
    }

    const { childStreamId, logger } = createChildStream(
      executionId,
      parentStreamId,
      {
        streamPrefix: 'bash@tool',
        streamCategory: AgentCategory.ToolUse,
        agentName: 'bash',
        description: command,
        config: syntheticConfig,
      },
    );
    const stdoutLog = logger.createStream('default');
    const stderrLog = logger.createStream('default', { level: 'warn' });
    const session = new BashBackgroundSession();
    registerInterruptible(childStreamId, session);

    const startedAt = Date.now();
    const promise = executeCommand(command, {
      timeout: timeoutMs,
      buffer: false,
      onPid: (p) => {
        session.setPid(p);
      },
      onStdout: (chunk) => stdoutLog.append(chunk),
      onStderr: (chunk) => stderrLog.append(chunk),
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
        const outputTail = stdoutLog.finalize();
        const stderrTail = stderrLog.finalize();

        const terminalStatus = result.success ? 'completed' : 'error';
        await writeTerminalStatus(executionId, terminalStatus).catch(() => {});
        finalizeChildStream(childStreamId, executionId, logger, {
          wallTimeMs,
          error: result.success
            ? undefined
            : new ToolError(
                `Background bash failed with exit code ${result.exitCode ?? 'unknown'}.`,
              ),
        });
        unregisterInterruptible(childStreamId);

        const msg = formatBashDelivery(
          executionId,
          command,
          wallTimeMs,
          result,
          outputTail,
          stderrTail,
        );
        await store.writeReport(msg);
        ToolUseFollowUpQueue.enqueue(parentStreamId, msg);
      })
      .catch(async (err: unknown) => {
        stdoutLog.finalize();
        stderrLog.finalize();
        await writeTerminalStatus(executionId, 'error').catch(() => {});
        finalizeChildStream(childStreamId, executionId, logger, {
          error: err,
        });
        unregisterInterruptible(childStreamId);

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
