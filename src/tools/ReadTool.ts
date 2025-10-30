// Third-party imports
// Standard library imports

// Local imports - core
import { z } from 'zod';
import { defineTool } from './core/define';

// Local imports - tools
import { ToolResult, toolResult } from '@tools/result';
import { buildFileAttachment } from '@tools/utils';

// Local imports - utils
import { WorkspaceFS, getMimeType } from '@utils/files';

export const READ_FILE_MAX_LINES = 400;

const ReadInputSchema = z.strictObject({
  path: z.string(),
  range: z
    .strictObject({
      start: z.number().int().min(1),
      end: z.number().int().min(1).optional(),
    })
    .refine((value) => value.end === undefined || value.end >= value.start, {
      message: 'range.end must be greater than or equal to range.start',
      path: ['end'],
    })
    .optional(),
});

export type ReadInput = z.infer<typeof ReadInputSchema>;

interface BuildSummaryParams {
  path: string;
  totalLines: number;
  visibleCount: number;
  actualStartLine: number | null;
  actualEndLine: number | null;
  requestedStartLine: number;
  requestedEndLine: number;
  truncated: boolean;
  rangeProvided: boolean;
  rangeEndExceeded: boolean;
}

export class ReadFileTool extends defineTool({
  name: 'read_file',
  description:
    'Read and return the contents of a workspace file. Optionally specify a line range to read specific sections.',
  schema: ReadInputSchema,
}) {
  protected async execute(input: ReadInput): Promise<ToolResult> {
    if (this.isPdfPath(input.path)) {
      return this.returnPdfAttachment(input);
    }

    const content = await WorkspaceFS.read(input.path);
    const lines = content.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }

    const totalLines = lines.length;

    const requestedStartLine = input.range?.start ?? 1;
    const requestedEndLine =
      input.range?.end ??
      (input.range?.start
        ? Math.min(requestedStartLine + READ_FILE_MAX_LINES - 1, totalLines)
        : totalLines);

    // Convert the requested 1-based range into zero-based indices and clamp them to the
    // available file length so callers can safely request windows beyond the file bounds.
    // If startIndex >= totalLines, slice will return empty array (which is correct behavior).
    const startIndex = Math.min(requestedStartLine - 1, totalLines);
    const endIndexExclusive = Math.min(
      Math.max(requestedEndLine, requestedStartLine),
      totalLines,
    );

    const selectedLines = lines.slice(startIndex, endIndexExclusive);
    const truncated = selectedLines.length > READ_FILE_MAX_LINES;
    const visibleLines = truncated
      ? selectedLines.slice(0, READ_FILE_MAX_LINES)
      : selectedLines;
    const visibleCount = visibleLines.length;

    const segments: string[] = [];
    if (visibleLines.length > 0) {
      segments.push(visibleLines.join('\n'));
    }
    if (truncated) {
      segments.push(
        `...(truncated, ${selectedLines.length - READ_FILE_MAX_LINES} more lines)`,
      );
    }

    const actualStartLine = visibleCount > 0 ? startIndex + 1 : null;
    const actualEndLine = visibleCount > 0 ? startIndex + visibleCount : null;

    const summary = this.buildSummary({
      path: input.path,
      totalLines,
      visibleCount,
      actualStartLine,
      actualEndLine,
      requestedStartLine,
      requestedEndLine,
      truncated,
      rangeProvided: Boolean(input.range),
      rangeEndExceeded:
        input.range?.end !== undefined && input.range.end > totalLines,
    });

    return toolResult({
      summary,
      output: segments.join('\n'),
    });
  }

  private buildSummary({
    path,
    totalLines,
    visibleCount,
    actualStartLine,
    actualEndLine,
    requestedStartLine,
    requestedEndLine,
    truncated,
    rangeProvided,
    rangeEndExceeded,
  }: BuildSummaryParams): string {
    if (visibleCount === 0) {
      if (totalLines === 0) {
        return `Read ${path} (file is empty)`;
      }
      return `Read ${path} (no lines in requested range)`;
    }

    const safeActualStartLine = actualStartLine ?? 1;
    const safeActualEndLine =
      actualEndLine ?? safeActualStartLine + visibleCount - 1;
    const describeRange =
      rangeProvided ||
      truncated ||
      safeActualStartLine !== 1 ||
      safeActualEndLine !== totalLines;
    const rangeLabel =
      safeActualStartLine === safeActualEndLine
        ? `line ${safeActualStartLine}`
        : `lines ${safeActualStartLine}-${safeActualEndLine}`;

    let summary = describeRange
      ? `Read ${rangeLabel} of ${path}`
      : `Read ${path}`;

    if (rangeEndExceeded) {
      summary += ` (requested end ${requestedEndLine} exceeds file length ${totalLines})`;
    }

    return summary;
  }

  private isPdfPath(path: string): boolean {
    const mimeType = getMimeType(path)?.toLowerCase();
    if (mimeType === 'application/pdf') {
      return true;
    }
    return path.toLowerCase().endsWith('.pdf');
  }

  private async returnPdfAttachment(input: ReadInput): Promise<ToolResult> {
    const attachment = await buildFileAttachment({
      filePath: input.path,
      description: 'PDF returned by read_file tool.',
    });

    const summaryParts = [`Attached PDF ${attachment.path}.`];
    if (input.range) {
      summaryParts.push('Ignored requested line range because PDFs are binary.');
    }

    const outputParts: string[] = [];
    if (input.range) {
      outputParts.push('Line ranges are not supported when reading PDFs.');
    }
    outputParts.push(
      'Returned the PDF as a file attachment. Some models may not display attachments; download the file if needed.',
    );

    return toolResult({
      summary: summaryParts.join(' '),
      output: outputParts.join(' '),
      files: [attachment],
    });
  }
}
