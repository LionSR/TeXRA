// Third-party imports
// Standard library imports

// Local imports - core
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

// Local imports - tools
import { BaseTool } from './core/base';
import type { ToolDefinition } from '@model';
import { ToolResult, ToolError } from '@tools/result';
import { executeCommand } from '@utils/system/execUtils';

const BashInputSchema = z.object({
  command: z.string(),
});

export type BashInput = z.infer<typeof BashInputSchema>;

export class BashTool extends BaseTool<BashInput> {
  constructor() {
    const definition: ToolDefinition = {
      name: 'bash',
      description: 'Execute a shell command within the workspace',
      parameters: zodToJsonSchema(BashInputSchema),
    };
    super(definition, BashInputSchema);
  }

  protected async execute(input: BashInput): Promise<ToolResult> {
    const result = await executeCommand(input.command, { truncate: true });
    if (result.success) {
      return new ToolResult({ output: result.stdout || '' });
    }
    throw new ToolError(`Bash command failed: ${result.stderr || 'No error output available'}`);
  }
}
