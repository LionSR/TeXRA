// Third-party imports
// Standard library imports

// Local imports - core
import { z } from 'zod';
import { defineTool } from './core/define';

// Local imports - tools
import { ToolResult, ToolError } from '@tools/result';
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
      return new ToolResult({ output: result.stdout || '' });
    }
    throw new ToolError(
      `Bash command failed: ${result.stderr || 'No error output available'}`,
    );
  }
}
