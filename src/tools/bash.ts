// Third-party imports
// Standard library imports

// Local imports - core
import { z } from 'zod';
import { defineTool } from './core/define';

// Local imports - tools
import { ToolResult, ToolError, toolResult } from '@tools/result';
import { executeCommand } from '@utils/system/execUtils';

const BashInputSchema = z.object({
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
    const result = await executeCommand(input.command, { truncate: true });
    if (result.success) {
      const commandPreview =
        input.command.length > 60
          ? `${input.command.slice(0, 57)}…`
          : input.command;
      return toolResult({
        summary: `Ran bash: ${commandPreview}`,
        output: result.stdout || '',
      });
    }
    throw new ToolError(
      `Bash command failed: ${result.stderr || 'No error output available'}`,
    );
  }
}
