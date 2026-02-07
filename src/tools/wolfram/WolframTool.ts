// Local imports - core
import { z } from 'zod';

// Internal imports
import { ToolResult, ToolError } from '@tools/result';
import { WOLFRAM_CODE_TIMEOUT_MS, buildTimeoutMessage } from '@tools/timeouts';
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
  description: `Execute Wolfram Language code. Use this tool for quick calculations, symbolic math, and one-off evaluations. Sessions do NOT persist between calls - each execution starts fresh with no memory of previous variables or definitions. For complex scripts requiring session persistence, iterative development, or saving intermediate results, write to a .wl file and run via bash instead. IMPORTANT: Never hardcode expected values in Print statements - always compute and display actual results dynamically. Write tests using VerificationTest or assertions to verify properties, printing computed values rather than predetermined strings.`,
  schema: WolframInputSchema,
}) {
  protected async execute(input: WolframInput): Promise<ToolResult> {
    const effectiveTimeout = input.timeout ?? WOLFRAM_CODE_TIMEOUT_MS;
    const result = await executeWolframCode(input.code, {
      timeout: effectiveTimeout,
      showErrorsToUser: false,
    });
    if (result.success) {
      return {
        summary: 'Executed',
        output: result.output ?? '',
      };
    }

    // Build informative error message with all available context
    const errorParts: string[] = [];

    // Check for timeout first - most common cause of silent failures
    if (result.timedOut) {
      errorParts.push(buildTimeoutMessage('Execution', effectiveTimeout));
    }

    // Include exit code for debugging (non-zero indicates error)
    if (result.exitCode !== null && result.exitCode !== 0) {
      errorParts.push(`exit code ${result.exitCode}`);
    }

    // Wolfram often outputs errors to stdout rather than stderr
    // Include both if available for complete context, wrapped in XML tags
    if (result.error) {
      errorParts.push(`<stderr>${result.error}</stderr>`);
    }
    if (result.output) {
      errorParts.push(`<stdout>${result.output}</stdout>`);
    }

    const errorDetails =
      errorParts.length > 0
        ? errorParts.join('\n')
        : 'No error details available';
    throw new ToolError(`Wolfram execution failed: ${errorDetails}`);
  }
}
