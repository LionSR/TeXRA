// Local imports - core
import { z } from 'zod';

// Local imports - agent
import { getCurrentToolFileInteractionContext } from '@agent/toolUse/ToolFileInteractionContext';

// Local imports - tools
import { ToolError, ToolResult } from '@tools/result';
import { buildTimeoutMessage } from '@tools/timeouts';
import {
  buildBashApprovalRejectedResult,
  requestBashApproval,
} from '@tools/approval/bashApproval';
import { executeCommand } from '@utils/system/execUtils';

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
});

export type BashInput = z.infer<typeof BashInputSchema>;

export class BashTool extends defineTool({
  name: 'bash',
  description:
    'Execute shell commands. Returns stdout on success, throws error with stderr on failure.',
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

    // Truncation only applies to internal logging so long-running commands keep
    // the output channel readable while still returning the complete stdout.
    // Stream both stdout and stderr through the same callback for live UI updates.
    const result = await executeCommand(input.command, {
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
      const commandPreview =
        input.command.length > 60
          ? `${input.command.slice(0, 57)}…`
          : input.command;
      return {
        summary: `Executed: ${commandPreview} (exit 0)`,
        output: result.stdout || '',
      };
    }
    // Many CLI tools (including latexmk) write errors to stdout, not stderr
    const outputs = [result.stderr, result.stdout].filter(Boolean);
    const errorOutput = outputs.join('\n') || 'No error output available';
    throw new ToolError(`Command failed: ${errorOutput}`);
  }
}
