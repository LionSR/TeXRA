// Third-party imports
import { z } from 'zod';

// Local imports - tools
import { ToolResult, ToolError } from '@tools/result';
import { defineTool } from '@tools/core/define';

// Local imports - utils
import { truncateWithEllipsis } from '@utils/text/stringUtils';

// Local file imports
import {
  WOLFRAM_CODE_TIMEOUT_MS,
  executeWolframCode,
} from './wolframScriptUtils';

/**
 * Build a content-bearing summary for a wolfram run so concurrent calls render
 * as distinct rows instead of an indistinguishable wall of "wolfram (Executed)".
 * Mirrors bash's `Executed: <preview>` convention; uses the first non-blank
 * line of the code so multi-line scripts still get a meaningful header.
 */
export function wolframRunSummary(code: string): string {
  const firstLine = code
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const preview = firstLine ? truncateWithEllipsis(firstLine, 60) : '';
  return preview ? `Executed: ${preview}` : 'Executed';
}

const WolframInputSchema = z.strictObject({
  code: z.string(),
  timeout: z
    .int()
    .min(1000)
    .max(600_000)
    .nullish()
    .describe(
      'Timeout in milliseconds (max 600,000 ms / 10 min, default 30,000 ms / 30 s).',
    ),
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
    });
    if (result.success) {
      return {
        summary: wolframRunSummary(input.code),
        output: result.output ?? '',
      };
    }

    // Build informative error message with all available context
    const parts: string[] = [];
    if (result.timedOut) {
      parts.push(
        `Execution timed out after ${effectiveTimeout / 1000}s.\n` +
          `To fix: increase the timeout parameter up to 600s (600000ms): { "timeout": 600000 }`,
      );
    }
    if (result.exitCode !== null && result.exitCode !== 0) {
      parts.push(`exit code ${result.exitCode}`);
    }
    if (result.error) parts.push(`<stderr>${result.error}</stderr>`);
    if (result.output) parts.push(`<stdout>${result.output}</stdout>`);

    const details = parts.join('\n') || 'No error details available';
    throw new ToolError(`Wolfram execution failed: ${details}`);
  }
}
