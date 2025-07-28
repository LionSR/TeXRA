import { z } from 'zod';
import type { ToolDefinition } from '@model';
import { BaseTool } from '../core/base';
import { ToolResult } from '../result';
import { executeWolframCode } from './wolframScriptUtils';
import { zodToJsonSchema } from 'openai/_vendor/zod-to-json-schema/index.js';

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
      parameters: zodToJsonSchema(WolframInputSchema, { name: 'wolframInput' }),
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
    return new ToolResult({
      error: result.error ?? 'Execution failed',
      isError: true,
    });
  }
}
