// Third-party imports
// Standard library imports

// Local imports - core
import { z } from 'zod';
import { defineTool } from '../core/define';

// Local imports - tools
import { ToolResult, ToolError, toolResult } from '../result';
import { executeWolframCode } from './wolframScriptUtils';

const WolframInputSchema = z.object({
  code: z.string(),
  timeout: z.number().optional(),
});

export type WolframInput = z.infer<typeof WolframInputSchema>;

export class WolframTool extends defineTool({
  name: 'wolfram',
  description: 'Execute Wolfram Language code',
  schema: WolframInputSchema,
}) {
  protected async execute(input: WolframInput): Promise<ToolResult> {
    const result = await executeWolframCode(input.code, {
      timeout: input.timeout,
      showErrorsToUser: false,
    });
    if (result.success) {
      return toolResult({
        summary: 'Executed Wolfram code',
        output: result.output ?? '',
      });
    }
    throw new ToolError(
      `Wolfram execution failed: ${result.error ?? 'No error details available'}`,
    );
  }
}
