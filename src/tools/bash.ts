// Standard library imports
import * as fs from 'fs';
import { writeFile } from 'fs/promises';
import * as path from 'path';

// Third-party imports
import { z } from 'zod';

// Local imports - agent
import type { StreamTabId, ExecutionId } from '@shared/schemas';
import { getCurrentToolFileInteractionContext } from '@agent/toolUse/ToolFileInteractionContext';
import {
  trackExecution,
  untrackExecution,
  ProcessExecutionHandle,
} from '@agent/runtime/executionRegistry';
import { getExecutionStore } from '@agent/storage';
import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';

// Local imports - common
import { AgentHistoryManager } from '@common/history/AgentHistoryManager';
import { AgentConfigSchema } from '@agent/core/AgentConfig';

// Local imports - tools
import { ToolError, type ToolResult } from '@tools/result';
import { buildTimeoutMessage } from '@tools/timeouts';
import {
  buildBashApprovalRejectedResult,
  requestBashApproval,
} from '@tools/approval/bashApproval';
import { formatBashDelivery, formatBashError } from '@tools/subagentResults';
import { executeCommand } from '@utils/system/execUtils';

// Local imports - utils
import { generateExecutionId } from '@utils/core/executionId';
import { ensureRunDir, getRunDir } from '@utils/files/taskRunStorage';

// Local file imports
import { defineTool } from './core/define';

const BASH_TIMEOUT_MS = 120_000; // 120 s

const BashInputSchema = z.strictObject({
  command: z.string(),
  timeout: z
    .number()
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
      'Run command in background. Returns immediately with execution ID. Output captured to executions/{id}/output. Result delivered as follow-up when complete.',
    ),
});

export type BashInput = z.infer<typeof BashInputSchema>;

export class BashTool extends defineTool({
  name: 'bash',
  description:
    'Execute shell commands. Returns stdout on success, throws error with stderr on failure. Use run_in_background for long-running commands.',
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
    const result = await executeCommand(command, {
      truncate: true,
      timeout: timeoutMs,
      onStdout: ctx?.onToolOutput,
      onStderr: ctx?.onToolOutput,
    });

    if (result.timedOut) {
      const parts: string[] = [
        buildTimeoutMessage('Command execution', timeoutMs),
      ];
      if (result.stdout) parts.push(`<stdout>${result.stdout}</stdout>`);
      if (result.stderr) parts.push(`<stderr>${result.stderr}</stderr>`);
      parts.push(
        'Increase the timeout parameter (in milliseconds) if the command needs more time.',
      );
      throw new ToolError(parts.join('\n'));
    }

    if (result.success) {
      const preview =
        command.length > 60 ? `${command.slice(0, 57)}…` : command;
      return {
        summary: `Executed: ${preview} (exit 0)`,
        output: result.stdout || '',
      };
    }
    // Many CLI tools (including latexmk) write errors to stdout, not stderr
    const errorOutput =
      [result.stderr, result.stdout].filter(Boolean).join('\n') ||
      'No error output available';
    throw new ToolError(`Command failed: ${errorOutput}`);
  }

  private async executeBackground(
    command: string,
    timeoutMs: number,
    parentStreamId: StreamTabId | undefined,
    parentExecutionId: ExecutionId | undefined,
  ): Promise<ToolResult> {
    const executionId = generateExecutionId();
    await ensureRunDir(executionId);

    const outputPath = path.join(getRunDir(executionId), 'output.log');
    const outputStream = fs.createWriteStream(outputPath, { flags: 'a' });

    const appendToOutput = (chunk: string): void => {
      outputStream.write(chunk);
    };

    const preview = command.length > 60 ? `${command.slice(0, 57)}…` : command;

    let pid: number | undefined;
    const startedAt = Date.now();
    const promise = executeCommand(command, {
      timeout: timeoutMs,
      onPid: (p) => {
        pid = p;
      },
      onStdout: appendToOutput,
      onStderr: appendToOutput,
    });

    const kill = (): void => {
      if (!pid) return;
      // Try process-group kill first; fall back to direct PID on Windows or if already exited
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          /* already exited */
        }
      }
    };

    const handle = new ProcessExecutionHandle(
      executionId,
      parentStreamId ?? executionId,
      preview,
      kill,
    );
    trackExecution(handle);

    const syntheticConfig = AgentConfigSchema.parse({
      agent: 'bash',
      instruction: command,
    });
    const timestamp = new Date().toISOString();
    void AgentHistoryManager.addToHistory(
      executionId,
      syntheticConfig,
      parentExecutionId,
    );
    const kvStore = getExecutionStore(executionId);
    void kvStore.write('config', syntheticConfig);
    void kvStore.write('meta', { timestamp, parentExecutionId });
    if (parentExecutionId) {
      void getExecutionStore(parentExecutionId).write(`child-${executionId}`, {
        agent: 'bash',
        timestamp,
      });
    }

    void promise
      .then(async (result) => {
        const wallTimeMs = Date.now() - startedAt;

        const metaPath = path.join(getRunDir(executionId), 'meta.json');
        await writeFile(
          metaPath,
          JSON.stringify(
            {
              exitCode: result.exitCode,
              wallTimeMs,
              success: result.success,
              timedOut: result.timedOut,
              command,
            },
            null,
            2,
          ),
        );

        untrackExecution(executionId);

        if (parentStreamId) {
          const msg = formatBashDelivery(
            executionId,
            command,
            wallTimeMs,
            result,
          );
          void getExecutionStore(executionId).write('report', msg);
          ToolUseFollowUpQueue.enqueue(parentStreamId, msg);
        }
      })
      .catch((err: unknown) => {
        untrackExecution(executionId);

        if (parentStreamId) {
          const msg = formatBashError(executionId, command, err);
          void getExecutionStore(executionId).write('report', msg);
          ToolUseFollowUpQueue.enqueue(parentStreamId, msg);
        }
      })
      .finally(() => {
        outputStream.end();
      });

    return {
      summary: `Launched background: ${preview}`,
      output: [
        `Command launched in background.`,
        `Execution ID: ${executionId}`,
        `Output: executions path=/executions/${executionId}/output`,
        `Status: executions path=/executions/${executionId} block=true`,
        'Result will be delivered as a follow-up message when complete.',
      ].join('\n'),
    };
  }
}
