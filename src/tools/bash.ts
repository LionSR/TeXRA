// Local imports - core
import { z } from 'zod';

// Local imports - tools
import { ToolError, ToolResult } from '@tools/result';
import {
  buildBashApprovalRejectedResult,
  requestBashApproval,
} from '@tools/approval/bashApproval';
import { executeCommand } from '@utils/system/execUtils';

// Local file imports
import { defineTool } from './core/define';

const BashInputSchema = z.strictObject({
  command: z.string(),
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

    // Truncation only applies to internal logging so long-running commands keep
    // the output channel readable while still returning the complete stdout.
    const result = await executeCommand(input.command, { truncate: true });
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
