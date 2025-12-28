// Local imports - core
import { z } from 'zod';

// Internal imports
import { ToolResult, ToolError, toolResult } from '@tools/result';
import { defineTool } from '@tools/core/define';

// Local imports - tools
import { executeWolframCode } from './wolframScriptUtils';

const WolframInputSchema = z.strictObject({
  code: z.string(),
  timeout: z.number().nullish(),
});

export type WolframInput = z.infer<typeof WolframInputSchema>;

export class WolframTool extends defineTool({
  name: 'wolfram',
  description: 'Execute Wolfram Language code',
  schema: WolframInputSchema,
}) {
  protected async execute(input: WolframInput): Promise<ToolResult> {
    const result = await executeWolframCode(input.code, {
      timeout: input.timeout ?? undefined,
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
