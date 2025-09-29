// Third-party imports
import { z } from 'zod';

// Local imports - latex utilities
import {
  formatTeXCountStats,
  getTeXCount,
  type TexcountMode,
} from '@latex/texcount';

// Local imports - tool core
import { defineTool } from '@tools/core/define';
import { ToolError, toolResult, type ToolResult } from '@tools/result';

const TexcountInputSchema = z.object({
  files: z.union([z.string(), z.array(z.string()).min(1)]),
  mode: z.enum(['separate', 'include', 'sum']).optional(),
  format: z.enum(['raw', 'stats']).optional(),
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
    const output = await getTeXCount(files, { mode });

    if (!output) {
      return toolResult({
        error: 'texcount did not return any output. Ensure the files exist.',
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
