// Third-party imports
import { z } from 'zod';

// Local imports - latex utilities
import { ToolError, toolResult, type ToolResult } from '@tools/result';
import { defineTool } from '@tools/core/define';
import {
  formatTeXCountStats,
  getTeXCount,
  type TexcountMode,
} from '@latex/texcount';

// Local imports - tool core

const TexcountInputSchema = z.strictObject({
  files: z.union([z.string(), z.array(z.string()).min(1)]),
  mode: z.enum(['separate', 'include', 'sum']).nullish(),
  format: z.enum(['raw', 'stats']).nullish(),
});

type TexcountInput = z.infer<typeof TexcountInputSchema>;

function toFileArray(files: TexcountInput['files']): string[] {
  return Array.isArray(files) ? files : [files];
}

function formatOutput(output: string, format: TexcountInput['format']): string {
  if (format === 'stats') {
    return formatTeXCountStats(output);
  }
  return output;
}

export class TexcountTool extends defineTool({
  name: 'texcount',
  description:
    'Run texcount on one or more LaTeX files. Use mode="separate" (default) for individual files, "include" to follow \\input/\\include, or "sum" to aggregate independent sources.',
  schema: TexcountInputSchema,
}) {
  protected async execute(input: TexcountInput): Promise<ToolResult> {
    const files = toFileArray(input.files)
      .map((file) => file.trim())
      .filter((file) => file.length > 0);
    if (files.length === 0) {
      throw new ToolError('No LaTeX files provided for texcount.');
    }

    const mode: TexcountMode = input.mode ?? 'separate';
    const { output, errors } = await getTeXCount(files, { mode });

    if (!output) {
      const errorMessage =
        errors.join('\n') ||
        'texcount did not return any output. Ensure the files exist.';
      return toolResult({
        error: errorMessage,
        isError: true,
      });
    }

    const summary = `texcount analysis for ${files.length} file${
      files.length === 1 ? '' : 's'
    }`;

    return toolResult({
      summary,
      output: formatOutput(output, input.format),
    });
  }
}
