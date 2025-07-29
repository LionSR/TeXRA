// Standard library imports

// Local imports - core
import { z } from 'zod';
import { BashSession } from '@utils/system/bashSession';
import { BaseTool } from './core/base';
import { ToolResult } from '@tools/result';
import type { ToolDefinition } from '@model';
import { zodToJsonSchema } from 'zod-to-json-schema';

const BashInputSchema = z
  .object({
    command: z.string().optional(),
    restart: z.boolean().optional(),
  })
  .refine((data) => data.command || data.restart, {
    message: 'command or restart required',
  });

export type BashInput = z.infer<typeof BashInputSchema>;
const bashSession = new BashSession();

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
    if (input.restart) {
      bashSession.restart();
      return new ToolResult({ output: 'Bash session restarted' });
    }
    const result = await bashSession.execute(input.command ?? '', {
      truncate: true,
    });
    if (result.success) {
      return new ToolResult({ output: result.stdout || '' });
    }
    return new ToolResult({
      error: result.timedOut
        ? 'Error: Command timed out'
        : result.stderr || 'Command failed',
      isError: true,
    });
  }
}
