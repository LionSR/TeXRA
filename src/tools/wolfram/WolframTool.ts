// Third-party imports
import { z } from 'zod';

// Local imports
import { getCurrentToolContexts } from '@agent/followUp/ToolFileInteractionContext';
import { ToolResult, ToolError } from '@shared/schemas/toolResult';
import { defineTool } from '@tools/core/define';
import {
  buildBashApprovalRejectedResult,
  requestBashApproval,
} from '@tools/approval/bashApproval';
import { executed } from '@tools/core/result';
import {
  splitContentLines,
  truncateWithEllipsis,
} from '@utils/text/stringUtils';

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
  const firstLine = splitContentLines(code).find((line) => line.trim());
  const preview = firstLine ? truncateWithEllipsis(firstLine.trim(), 60) : '';
  return preview ? `Executed: ${preview}` : 'Executed';
}

export function wolframApprovalCommand(code: string): string {
  return `wolframscript -code ${JSON.stringify(code)}`;
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
  requiresApproval: true,
  slow: true,
  deferLogUntilApproval: true,
  description: `Execute approval-gated Wolfram Language code. Use this tool for quick calculations, symbolic math, and one-off evaluations only when Wolfram/external computation is allowed by the user. Do not use it when the user requested a specific verification method or prohibited external computation. Sessions do NOT persist between calls - each execution starts fresh with no memory of previous variables or definitions. For complex scripts requiring session persistence, iterative development, or saving intermediate results, write to a .wl file and run via bash instead. Compute and print actual results: do not hardcode expected values in Print statements; use VerificationTest or assertions so output reflects real computation.`,
  schema: WolframInputSchema,
}) {
  protected async execute(input: WolframInput): Promise<ToolResult> {
    const command = wolframApprovalCommand(input.code);
    const approval = await requestBashApproval({ command });
    if (approval.action !== 'approve') {
      return buildBashApprovalRejectedResult(command, approval.feedback);
    }

    getCurrentToolContexts()?.callContext?.hooks?.onExecutionReady?.();

    const effectiveTimeout = input.timeout ?? WOLFRAM_CODE_TIMEOUT_MS;
    const result = await executeWolframCode(input.code, {
      timeout: effectiveTimeout,
    });
    if (result.success) {
      return executed(result.output ?? '', wolframRunSummary(input.code));
    }

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
