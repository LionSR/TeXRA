// Third-party imports
import { z } from 'zod';

// Local imports - latex utilities
import { getCurrentToolCallContext } from '@agent/followUp/ToolFileInteractionContext';
import { getTeXCount } from '@latex/texcount';
import { ToolError, type ToolResult } from '@shared/schemas';
import { defineTool } from '@tools/core/define';
import { executed } from '@tools/core/result';
import { withDefault } from '@tools/core/schemaDefaults';
import { ensureArray } from '@utils/core';
import { formatResultCount } from '@utils/text/stringUtils';

const TexcountInputSchema = z.strictObject({
  files: z
    .union([z.string(), z.array(z.string()).min(1)])
    .describe('LaTeX file path or non-empty list of LaTeX files to count.'),
  mode: withDefault(
    z.enum(['separate', 'include', 'sum']),
    'separate' as const,
  ).describe('How texcount should combine files: separate, include, or sum.'),
  format: z
    .enum(['raw', 'stats'])
    .nullish()
    .describe('Return raw texcount output or wrap it as stats.'),
});

type TexcountInput = z.infer<typeof TexcountInputSchema>;

export class TexcountTool extends defineTool({
  name: 'texcount',
  parallelSafe: true,
  description:
    'Run texcount on one or more LaTeX files. Use mode="separate" (default) for individual files, "include" to follow \\input/\\include, or "sum" to aggregate independent sources.',
  schema: TexcountInputSchema,
}) {
  protected async execute(input: TexcountInput): Promise<ToolResult> {
    const files = ensureArray(input.files)
      .map((file) => file.trim())
      .filter((file) => file.length > 0);
    if (files.length === 0) {
      throw new ToolError('No LaTeX files provided for texcount.');
    }

    // Thread the tool call's abort signal to the texcount subprocess so a
    // cancelled parallel batch terminates it instead of waiting it out.
    const { output, errors } = await getTeXCount(files, {
      mode: input.mode,
      signal: getCurrentToolCallContext()?.signal,
    });

    if (!output) {
      throw new ToolError(
        errors.join('\n') ||
          'texcount did not return any output. Ensure the files exist.',
      );
    }

    return executed(
      input.format === 'stats'
        ? `TeX Count Statistics:<texcount>\n${output}\n</texcount>\n\n`
        : output,
      `Analyzed: ${formatResultCount(files.length, 'file')}`,
    );
  }
}
