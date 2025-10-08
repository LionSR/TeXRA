// Third-party imports
// Standard library imports

// Local imports - core
import { z } from 'zod';
import { defineTool } from './core/define';

// Local imports - tools
import { ToolResult, toolResult } from '@tools/result';

// Local imports - utils
import { WorkspaceFS } from '@utils/files';

export const READ_FILE_MAX_LINES = 400;

const ReadInputSchema = z.strictObject({
  path: z.string(),
  range: z
    .strictObject({
      start: z.number().int().positive(),
      end: z.number().int().positive().optional(),
    })
    .refine((value) => value.end === undefined || value.end >= value.start, {
      message: 'range.end must be greater than or equal to range.start',
      path: ['end'],
    })
    .optional(),
});

export type ReadInput = z.infer<typeof ReadInputSchema>;

export class ReadFileTool extends defineTool({
  name: 'read_file',
  description: 'Read and return the contents of a workspace file.',
  schema: ReadInputSchema,
}) {
  protected async execute(input: ReadInput): Promise<ToolResult> {
    const content = await WorkspaceFS.read(input.path);
    const lines = content.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }

    const totalLines = lines.length;
    const requestedStartLine = Math.max(input.range?.start ?? 1, 1);
    const requestedEndLine = Math.max(
      input.range?.end ?? totalLines,
      input.range?.start ?? 1,
    );
    const startIndex = Math.min(Math.max(requestedStartLine - 1, 0), totalLines);
    const endIndexExclusive = Math.min(
      Math.max(requestedEndLine, requestedStartLine - 1),
      totalLines,
    );

    const selectedLines = lines.slice(startIndex, endIndexExclusive);
    const truncated = selectedLines.length > READ_FILE_MAX_LINES;
    const visibleLines = truncated
      ? selectedLines.slice(0, READ_FILE_MAX_LINES)
      : selectedLines;
    const visibleCount = visibleLines.length;
    const actualStartLine = visibleCount > 0 ? requestedStartLine : undefined;
    const actualEndLine =
      visibleCount > 0 ? requestedStartLine + visibleCount - 1 : undefined;

    const segments: string[] = [];
    if (visibleLines.length > 0) {
      segments.push(visibleLines.join('\n'));
    }
    if (truncated) {
      segments.push(
        `...(truncated, ${selectedLines.length - READ_FILE_MAX_LINES} more lines)`,
      );
    }

    const summary = (() => {
      if (visibleCount === 0) {
        return `Read ${input.path} (no lines in requested range)`;
      }

      if (
        input.range ||
        truncated ||
        actualStartLine !== 1 ||
        actualEndLine !== totalLines
      ) {
        const rangeLabel =
          actualStartLine === actualEndLine
            ? `line ${actualStartLine}`
            : `lines ${actualStartLine}-${actualEndLine}`;
        return `Read ${rangeLabel} of ${input.path}`;
      }

      return `Read ${input.path}`;
    })();

    return toolResult({
      summary,
      output: segments.join('\n'),
    });
  }
}
