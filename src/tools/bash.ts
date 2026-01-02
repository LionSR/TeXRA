// Local imports - core
import { z } from 'zod';

// Local imports - tools
import { ToolResult, ToolError } from '@tools/result';
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
    // Truncation only applies to internal logging so long-running commands keep
    // the output channel readable while still returning the complete stdout.
    const result = await executeCommand(input.command, { truncate: true });
    if (result.success) {
      const commandPreview =
        input.command.length > 60
          ? `${input.command.slice(0, 57)}…`
          : input.command;
      return {
        summary: `Ran bash: ${commandPreview}`,
        output: result.stdout || '',
      });
    }
    throw new ToolError(
      `Bash command failed: ${result.stderr || 'No error output available'}`,
    );
  }
}
