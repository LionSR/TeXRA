// Standard library imports
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
  trackExecution,
  untrackExecution,
  ProcessExecutionHandle,
} from '@agent/runtime/executionRegistry';
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
import { executeCommand, signalProcessGroup } from '@utils/system/execUtils';

// Local imports - utils
import { generateExecutionId } from '@utils/core/executionId';
import { ensureRunDir } from '@utils/files/taskRunStorage';

// Local file imports
import { defineTool } from './core/define';

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
      'Run command in background. Returns immediately with execution ID. Output captured to executions/{id}/output. Result delivered as follow-up when complete.',
    ),
});

export type BashInput = z.infer<typeof BashInputSchema>;

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

    if (result.success) {
      const preview =
        command.length > 60 ? `${command.slice(0, 57)}…` : command;
      return {
        summary: `Executed: ${preview} (exit 0)`,
        output: result.stdout ?? '',
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
    if (!parentStreamId) {
      throw new ToolError(
        'Background execution requires a parent stream context.',
      );
    }

    const executionId = generateExecutionId();

    // Ephemeral temp files for live output (cleaned up on completion)
    const stdoutPath = path.join(
      os.tmpdir(),
      `texra-bg-${executionId}-stdout.log`,
    );
    const stderrPath = path.join(
      os.tmpdir(),
      `texra-bg-${executionId}-stderr.log`,
    );
    const stdoutStream = fs.createWriteStream(stdoutPath, { flags: 'a' });
    const stderrStream = fs.createWriteStream(stderrPath, { flags: 'a' });
    stdoutStream.on('error', () => {}); // prevent unhandled emitter crash
    stderrStream.on('error', () => {});

    await ensureRunDir(executionId);

    const preview = command.length > 60 ? `${command.slice(0, 57)}…` : command;

    let pid: number | undefined;
    const startedAt = Date.now();
    const promise = executeCommand(command, {
      timeout: timeoutMs,
      buffer: false, // Output is streamed to disk; don't buffer in memory
      onPid: (p) => {
        pid = p;
      },
      onStdout: (chunk) => stdoutStream.write(chunk),
      onStderr: (chunk) => stderrStream.write(chunk),
    });

    const kill = (): boolean => {
      if (!pid) return false;
      return signalProcessGroup(pid, 'SIGTERM');
    };

    const syntheticConfig = AgentConfigSchema.parse({
      agent: 'bash',
      instruction: command,
    });

    // Attach lifecycle handlers BEFORE registerExecution so they're
    // always wired, even if registration throws.
    const handle = new ProcessExecutionHandle(
      executionId,
      parentStreamId,
      preview,
      kill,
    );
    handle.outputPaths = { stdout: stdoutPath, stderr: stderrPath };

    try {
      await registerExecution(
        executionId,
        syntheticConfig,
        'bash',
        parentExecutionId,
        'process',
      );
    } catch {
      // Registration failed — still attach cleanup but don't track
      void promise.finally(() => {
        stdoutStream.end();
        stderrStream.end();
      });
      throw new ToolError('Failed to register background execution.');
    }

    trackExecution(handle);

    const cleanupTempFiles = (): void => {
      stdoutStream.end();
      stderrStream.end();
      handle.outputPaths = undefined;
      // Fire-and-forget unlink
      void fs.promises.unlink(stdoutPath).catch(() => {});
      void fs.promises.unlink(stderrPath).catch(() => {});
    };

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

        // Read tail of temp files before cleanup (fixes blank preview bug
        // caused by buffer:false leaving result.stdout empty)
        const [outputTail, stderrTail] = await Promise.all([
          fs.promises.readFile(stdoutPath, 'utf-8').catch(() => ''),
          fs.promises.readFile(stderrPath, 'utf-8').catch(() => ''),
        ]);

        const terminalStatus = result.success ? 'completed' : 'error';
        await writeTerminalStatus(executionId, terminalStatus).catch(() => {});
        untrackExecution(executionId);

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
        await writeTerminalStatus(executionId, 'error').catch(() => {});
        untrackExecution(executionId);

        const msg = formatBashError(executionId, command, err);
        await getExecutionStore(executionId).writeReport(msg);
        ToolUseFollowUpQueue.enqueue(parentStreamId, msg);
      })
      .finally(cleanupTempFiles);

    return {
      summary: `Launched background: ${preview}`,
      output: [
        `Command launched in background.`,
        `Execution ID: ${executionId}`,
        `To read output: executions tool with path=/executions/${executionId}/output`,
        `To wait for completion: executions tool with path=/executions/${executionId} action=wait`,
        'Result will be delivered as a follow-up message when complete.',
      ].join('\n'),
    };
  }
}
