// Node imports

// Third-party imports
import { Effect } from 'effect';
import { z } from 'zod';

// Local imports
import { ToolCall } from '@agent/runtime/ToolCall';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { ToolError } from '@shared/schemas';
import { defineTool } from '@tools/core/define';
import { nullishWithDefault } from '@tools/core/inputSchema';
import { executed } from '@tools/core/result';
import { WOLFRAM_INSTALL_GUIDE } from '@tools/pluginManifest';
import { runToolWithCheck } from '@utils/system/toolUtils';
import { previewLabel, splitContentLines } from '@utils/text/stringUtils';

const WOLFRAM_CODE_TIMEOUT_MS = 30_000; // 30 s

const WOLFRAM_NOT_INSTALLED_ERROR = `"wolframscript" is not installed or not in your PATH.\n\n${WOLFRAM_INSTALL_GUIDE}`;

/**
 * Build a content-bearing summary for a wolfram run so concurrent calls render
 * as distinct rows instead of an indistinguishable wall of "wolfram (Executed)".
 * Mirrors bash's `Executed: <preview>` convention; uses the first non-blank
 * line of the code so multi-line scripts still get a meaningful header.
 */
function wolframRunSummary(code: string): string {
  const firstLine = splitContentLines(code).find((line) => line.trim());
  const preview = firstLine ? previewLabel(firstLine.trim()) : '';
  return preview ? `Executed: ${preview}` : 'Executed';
}

function wolframApprovalCommand(code: string): string {
  return `wolframscript -code ${JSON.stringify(code)}`;
}

const WolframInputSchema = z.strictObject({
  code: z.string(),
  timeout: nullishWithDefault(
    z.int().min(1000).max(600_000),
    WOLFRAM_CODE_TIMEOUT_MS,
  ).describe(
    'Timeout in milliseconds (max 600,000 ms / 10 min, default 30,000 ms / 30 s).',
  ),
});

type WolframInput = z.infer<typeof WolframInputSchema>;

/**
 * The calling turn's ambient collaborators, taken in `execute` rather than
 * read from the program's fiber: the command runner resolves the session from
 * process-wide storage.
 */
interface WolframPorts {
  readonly runTool: typeof runToolWithCheck;
  /** The run's workspace root, passed as the command's cwd, which
   *  `executeCommand` requires every caller to name. */
  readonly cwd: string | undefined;
  /** The same session's setting slots, carried beside the root as data. */
  readonly settings: SettingsStores;
}

const runWolfram = Effect.fn('WolframTool.execute')(function* (
  ports: WolframPorts,
  input: WolframInput,
) {
  // `runToolWithCheck` answers `false` for a missing `wolframscript` and
  // reports a failed run in its `ExecResult`. Interrupting the tool kills the
  // process: the interruption is what aborts the spawn.
  const result = yield* ports.runTool('wolframscript', ['-code', input.code], {
    cwd: ports.cwd,
    settings: ports.settings,
    showError: false,
    truncate: false,
    timeout: input.timeout,
    channel: 'WolframTool',
  });
  if (!result) {
    return yield* Effect.fail(new ToolError(WOLFRAM_NOT_INSTALLED_ERROR));
  }
  if (result.success) {
    return executed(result.stdout, wolframRunSummary(input.code));
  }

  const parts: string[] = [];
  if (result.timedOut) {
    parts.push(
      `Run timed out after ${input.timeout / 1000}s.\n` +
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

export const WolframTool = defineTool({
  name: 'wolfram',
  requiresApproval: true,
  slow: true,
  description: `Execute approval-gated Wolfram Language code. Use this tool for quick calculations, symbolic math, and one-off evaluations only when Wolfram/external computation is allowed by the user. Do not use it when the user requested a specific verification method or prohibited external computation. Sessions do NOT persist between calls - each run starts fresh with no memory of previous variables or definitions. For complex scripts requiring session persistence, iterative development, or saving intermediate results, write to a .wl file and run via bash instead. Compute and print actual results: do not hardcode expected values in Print statements; use VerificationTest or assertions so output reflects real computation.`,
  schema: WolframInputSchema,
  // The shell line the run would be, gated by the loop before the body runs.
  // `execute` passes the workspace as the command's cwd whatever working
  // directory the call was given, so the prompt names that one.
  guard: {
    bash: (input: WolframInput) =>
      Effect.succeed(wolframApprovalCommand(input.code)),
    cwd: 'workspace',
  },
  execute: Effect.fn('WolframTool.call')(function* (input: WolframInput) {
    const call = yield* ToolCall;
    const ports: WolframPorts = {
      runTool: runToolWithCheck,
      cwd: call.roots.workspace,
      settings: call.roots,
    };
    return yield* runWolfram(ports, input);
  }),
});
