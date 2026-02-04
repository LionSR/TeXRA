// Standard library imports
import * as path from 'path';

// Local imports - core
import { z } from 'zod';

// Local imports - tools
import { ToolResult } from '@tools/result';
import { buildFileAttachment, formatLinesWithNumbers } from '@tools/utils';
import { recordToolFileRead } from '@tools/fileInteractions';
import { WorkspaceFS, getMimeType } from '@utils/files';

// Local file imports
import { defineTool } from './core/define';

export const READ_FILE_MAX_LINES = 2000;

/**
 * Schema for range parameter with preprocessing to handle array format.
 * Some models (e.g., DeepSeek) may provide range as [start, end] array
 * instead of {start, end} object. This preprocessor normalizes both formats.
 */
const RangeSchema = z.preprocess(
  (val) => {
    // Convert array format [start, end] to object format {start, end}
    if (Array.isArray(val) && val.length >= 1) {
      return { start: val[0], end: val[1] };
    }
    return val;
  },
  z
    .strictObject({
      start: z.int().min(1),
      end: z.int().min(1).nullish(),
    })
    // eslint-disable-next-line eqeqeq -- nullish check (null or undefined)
    .refine((value) => value.end == null || value.end >= value.start, {
      path: ['end'],
      error: 'range.end must be greater than or equal to range.start',
    }),
);

const ReadInputSchema = z.strictObject({
  path: z.string(),
  range: RangeSchema.nullish(),
});

export type ReadInput = z.infer<typeof ReadInputSchema>;

interface BuildSummaryParams {
  path: string;
  totalLines: number;
  visibleCount: number;
  actualStartLine: number | null;
  actualEndLine: number | null;
  requestedEndLine: number;
  truncated: boolean;
  rangeProvided: boolean;
  rangeEndExceeded: boolean;
}

export class ReadFileTool extends defineTool({
  name: 'read_file',
  description:
    'Read and return workspace files. For text files you can supply an optional line range. PDFs (.pdf) and common image formats are returned as attachments so vision-capable models can inspect their pages or visual content.',
  schema: ReadInputSchema,
}) {
  protected async execute(input: ReadInput): Promise<ToolResult> {
    const attachmentConfig = this.getAttachmentConfig(input.path);
    if (attachmentConfig) {
      const result = await this.returnBinaryAttachment(input, attachmentConfig);
      recordToolFileRead(input.path);
      return result;
    }

    const content = await WorkspaceFS.read(input.path);
    recordToolFileRead(input.path);
    const lines = content.split(/\r?\n/);
    if (lines.length > 0 && lines.at(-1) === '') {
      lines.pop();
    }

    const totalLines = lines.length;

    const requestedStartLine = input.range?.start ?? 1;
    const requestedEndLine = this.computeRequestedEndLine(
      input.range,
      requestedStartLine,
      totalLines,
    );

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
      const numberedLines = formatLinesWithNumbers(
        visibleLines,
        startIndex + 1,
      );
      segments.push(numberedLines.join('\n'));
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
      requestedEndLine,
      truncated,
      rangeProvided: Boolean(input.range),

      rangeEndExceeded:
        input.range?.end !== null &&
        input.range?.end !== undefined &&
        input.range.end > totalLines,
    });

    return {
      summary,
      output: segments.join('\n'),
    };
  }

  private buildSummary({
    path: filePath,
    totalLines,
    visibleCount,
    actualStartLine,
    actualEndLine,
    requestedEndLine,
    truncated,
    rangeProvided,
    rangeEndExceeded,
  }: BuildSummaryParams): string {
    if (visibleCount === 0) {
      const reason =
        totalLines === 0 ? 'file is empty' : 'no lines in requested range';
      return `Read ${filePath} (${reason})`;
    }

    const startLine = actualStartLine ?? 1;
    const endLine = actualEndLine ?? startLine + visibleCount - 1;
    const isFullRead =
      !rangeProvided && !truncated && startLine === 1 && endLine === totalLines;

    if (isFullRead) {
      return `Read ${filePath}`;
    }

    const rangeLabel =
      startLine === endLine
        ? `line ${startLine}`
        : `lines ${startLine}-${endLine}`;
    const base = `Read ${rangeLabel} of ${filePath}`;

    if (rangeEndExceeded) {
      return `${base} (requested end ${requestedEndLine} exceeds file length ${totalLines})`;
    }
    return base;
  }

  private computeRequestedEndLine(
    range: ReadInput['range'],
    requestedStartLine: number,
    totalLines: number,
  ): number {
    // eslint-disable-next-line eqeqeq -- nullish check (null or undefined)
    if (range?.end != null) {
      return range.end;
    }
    // eslint-disable-next-line eqeqeq -- nullish check (null or undefined)
    if (range?.start != null) {
      return Math.min(requestedStartLine + READ_FILE_MAX_LINES - 1, totalLines);
    }
    return totalLines;
  }

  private getAttachmentConfig(
    filePath: string,
  ): { kind: 'pdf' | 'image'; label: string } | null {
    const mimeType = getMimeType(filePath)?.toLowerCase();
    // Keep extension detection case-insensitive so users can reference files regardless of casing.
    const extension = path.extname(filePath.toLowerCase());

    const isPdf = mimeType === 'application/pdf' || extension === '.pdf';
    if (isPdf) {
      return { kind: 'pdf', label: 'PDF' };
    }

    // Treat SVG as an image attachment so vision-capable models can inspect its rendered appearance
    // even though the underlying file is XML text.
    const isImage =
      mimeType?.startsWith('image/') || IMAGE_EXTENSIONS.has(extension);
    if (isImage) {
      return { kind: 'image', label: 'image' };
    }

    return null;
  }

  private async returnBinaryAttachment(
    input: ReadInput,
    config: { kind: 'pdf' | 'image'; label: string },
  ): Promise<ToolResult> {
    const copy = ATTACHMENT_COPY[config.kind];
    const attachment = await buildFileAttachment({
      filePath: input.path,
      description: `${config.label === 'PDF' ? 'PDF' : 'Image'} returned by read_file tool.`,
    });

    const baseSummary = `Attached ${config.label} ${attachment.path}.`;
    const summary = input.range
      ? `${baseSummary} ${copy.rangeSummary}`
      : baseSummary;
    const output = input.range
      ? `${copy.rangeOutput} ${copy.coreOutput}`
      : copy.coreOutput;

    return { summary, output, files: [attachment] };
  }
}

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.webp',
  '.tif',
  '.tiff',
  '.svg',
]);

const ATTACHMENT_COPY: Record<
  'pdf' | 'image',
  {
    rangeSummary: string;
    rangeOutput: string;
    coreOutput: string;
  }
> = {
  pdf: {
    rangeSummary: 'Ignored requested line range because PDFs are binary.',
    rangeOutput: 'Line ranges are not supported when reading PDFs.',
    coreOutput:
      'Returned the PDF as a file attachment. Vision-capable models can analyze each page with text and visual context.',
  },
  image: {
    rangeSummary: 'Ignored requested line range because images are binary.',
    rangeOutput: 'Line ranges are not supported when reading images.',
    coreOutput:
      'Returned the image as a file attachment. Vision-capable models can analyze the visual content directly.',
  },
};
