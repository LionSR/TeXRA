// Third-party imports
import { Effect } from 'effect';
import { z } from 'zod';

// Local imports - latex utilities
import { getTeXCount } from '@latex/texcount';
import { ToolError, type ToolResult } from '@shared/schemas';
import { defineTool } from '@tools/core/define';
import { nullishWithDefault } from '@tools/core/inputSchema';
import { executed } from '@tools/core/result';
import { ensureArray } from '@utils/core';
import { formatResultCount } from '@utils/text/stringUtils';

const TexcountInputSchema = z.strictObject({
  files: z
    .union([z.string(), z.array(z.string()).min(1)])
    .describe('LaTeX file path or non-empty list of LaTeX files to count.'),
  mode: nullishWithDefault(
    z.enum(['separate', 'include', 'sum']),
    'separate',
  ).describe('How texcount should combine files: separate, include, or sum.'),
  format: z
    .enum(['raw', 'stats'])
    .nullish()
    .describe('Return raw texcount output or wrap it as stats.'),
});

type TexcountInput = z.infer<typeof TexcountInputSchema>;

const texcount = Effect.fn('TexcountTool.execute')(function* (
  input: TexcountInput,
): Effect.fn.Return<ToolResult, ToolError> {
  const files = ensureArray(input.files)
    .map((file) => file.trim())
    .filter((file) => file.length > 0);
  if (files.length === 0) {
    return yield* Effect.fail(
      new ToolError('No LaTeX files provided for texcount.'),
    );
  }

  const { output, errors } = yield* getTeXCount(files, { mode: input.mode });

  if (!output) {
    return yield* Effect.fail(
      new ToolError(
        errors.join('\n') ||
          'texcount did not return any output. Ensure the files exist.',
      ),
    );
  }

  return executed(
    input.format === 'stats'
      ? `TeX Count Statistics:<texcount>\n${output}\n</texcount>\n\n`
      : output,
    `Analyzed: ${formatResultCount(files.length, 'file')}`,
  );
});

export class TexcountTool extends defineTool({
  name: 'texcount',
  parallelSafe: true,
  description:
    'Run texcount on one or more LaTeX files. Use mode="separate" (default) for individual files, "include" to follow \\input/\\include, or "sum" to aggregate independent sources.',
  schema: TexcountInputSchema,
}) {
  protected execute(input: TexcountInput): Effect.Effect<ToolResult, unknown> {
    // Cancelling a parallel batch interrupts this fiber, and the texcount
    // subprocesses abort with it — no signal is threaded through by hand.
    return texcount(input);
  }
}
