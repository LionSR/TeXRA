// Third-party imports
// Standard library imports

// Local imports - core
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

// Local imports - tools
import { BaseTool } from '../core/base';
import { ToolResult, ToolError } from '../result';
import { executeWolframCode } from './wolframScriptUtils';
import type { ToolDefinition } from '@model';

const WolframInputSchema = z.object({
  code: z.string(),
  timeout: z.number().optional(),
});

export type WolframInput = z.infer<typeof WolframInputSchema>;

export class WolframTool extends BaseTool<WolframInput> {
  constructor() {
    const definition: ToolDefinition = {
      name: 'wolfram',
      description: 'Execute Wolfram Language code',
      parameters: zodToJsonSchema(WolframInputSchema),
    };
    super(definition, WolframInputSchema);
  }

  protected async execute(input: WolframInput): Promise<ToolResult> {
    const result = await executeWolframCode(input.code, {
      timeout: input.timeout,
      showErrorsToUser: false,
    });
    if (result.success) {
      return new ToolResult({ output: result.output ?? '' });
    }
    throw new ToolError(result.error ?? 'Unknown error executing Wolfram code');
  }
}
