// Node imports
import { AsyncLocalStorage } from 'node:async_hooks';

// Third-party imports
import { Effect } from 'effect';
import { z } from 'zod';

// Local imports
import { getCurrentToolContexts } from '@agent/followUp/ToolFileInteractionContext';
import { hostPort } from '@common/hostPort';
import { effectRuntime } from '@platform/processRuntime';
import { ToolResult, ToolError } from '@shared/schemas';
import { defineTool } from '@tools/core/define';
import {
  buildBashApprovalRejectedResult,
  requestBashApproval,
} from '@tools/approval/bashApproval';
import { executed } from '@tools/core/result';
import { runToolWithCheck } from '@utils/system/toolUtils';
import { previewLabel, splitContentLines } from '@utils/text/stringUtils';

const WOLFRAM_CODE_TIMEOUT_MS = 30_000; // 30 s

const WOLFRAM_NOT_INSTALLED_ERROR =
  '"wolframscript" is not installed or not in your PATH. ' +
  'Having Mathematica installed is not enough: install the free ' +
  'Wolfram Engine (https://www.wolfram.com/engine/) which includes WolframScript.';

/**
 * Build a content-bearing summary for a wolfram run so concurrent calls render
 * as distinct rows instead of an indistinguishable wall of "wolfram (Executed)".
 * Mirrors bash's `Executed: <preview>` convention; uses the first non-blank
 * line of the code so multi-line scripts still get a meaningful header.
 */
export function wolframRunSummary(code: string): string {
  const firstLine = splitContentLines(code).find((line) => line.trim());
  const preview = firstLine ? previewLabel(firstLine.trim()) : '';
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

type WolframInput = z.infer<typeof WolframInputSchema>;

/**
 * The calling turn's ambient collaborators, taken in `execute` rather than
 * read from the program's fiber: the approval prompt and the command runner
 * both resolve the session, its bypass state and its workspace roots from
 * ambient storage, and the in-progress card belongs to this tool call.
 */
interface WolframPorts {
  readonly requestApproval: typeof requestBashApproval;
  readonly runTool: typeof runToolWithCheck;
  readonly onRunReady: (() => void) | undefined;
}

const runWolfram = Effect.fn('WolframTool.execute')(function* (
  ports: WolframPorts,
  input: WolframInput,
) {
  const command = wolframApprovalCommand(input.code);
  const approval = yield* hostPort(() => ports.requestApproval({ command }));
  if (approval.action !== 'approve') {
    return buildBashApprovalRejectedResult(command, approval);
  }

  ports.onRunReady?.();

  const effectiveTimeout = input.timeout ?? WOLFRAM_CODE_TIMEOUT_MS;
  const result = yield* hostPort(() =>
    ports.runTool('wolframscript', ['-code', input.code], {
      showError: false,
      truncate: false,
      timeout: effectiveTimeout,
      channel: 'WolframTool',
    }),
  );
  if (!result) {
    return yield* Effect.fail(new ToolError(WOLFRAM_NOT_INSTALLED_ERROR));
  }
  if (result.success) {
    return executed(result.stdout, wolframRunSummary(input.code));
  }

  const parts: string[] = [];
  if (result.timedOut) {
    parts.push(
      `Run timed out after ${effectiveTimeout / 1000}s.\n` +
        `To fix: increase the timeout parameter up to 600s (600000ms): { "timeout": 600000 }`,
    );
  }
  if (result.exitCode !== 0) {
    parts.push(`exit code ${result.exitCode}`);
  }
  if (result.stderr) parts.push(`<stderr>${result.stderr}</stderr>`);
  if (result.stdout) parts.push(`<stdout>${result.stdout}</stdout>`);

  const details = parts.join('\n') || 'No error details available';
  return yield* Effect.fail(new ToolError(`Wolfram run failed: ${details}`));
});

export class WolframTool extends defineTool({
  name: 'wolfram',
  requiresApproval: true,
  slow: true,
  deferLogUntilApproval: true,
  description: `Execute approval-gated Wolfram Language code. Use this tool for quick calculations, symbolic math, and one-off evaluations only when Wolfram/external computation is allowed by the user. Do not use it when the user requested a specific verification method or prohibited external computation. Sessions do NOT persist between calls - each run starts fresh with no memory of previous variables or definitions. For complex scripts requiring session persistence, iterative development, or saving intermediate results, write to a .wl file and run via bash instead. Compute and print actual results: do not hardcode expected values in Print statements; use VerificationTest or assertions so output reflects real computation.`,
  schema: WolframInputSchema,
}) {
  protected execute(input: WolframInput): Promise<ToolResult> {
    const ports: WolframPorts = {
      requestApproval: AsyncLocalStorage.bind(requestBashApproval),
      runTool: AsyncLocalStorage.bind(runToolWithCheck),
      onRunReady: getCurrentToolContexts()?.callContext?.hooks?.onRunReady,
    };
    return effectRuntime().runPromise(runWolfram(ports, input));
  }
}
