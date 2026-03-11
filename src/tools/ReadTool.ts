// Standard library imports
import * as path from 'path';

// Third-party imports
import { z } from 'zod';

// Local imports - tools
import { ToolResult } from '@tools/result';
import { buildFileAttachment, formatLinesWithNumbers } from '@tools/utils';
import { recordToolFileRead } from '@tools/fileInteractions';
import { WorkspaceFS, getMimeType } from '@utils/files';
import { splitContentLines } from '@utils/text/stringUtils';

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

    const lines = splitContentLines(await WorkspaceFS.read(input.path));
    recordToolFileRead(input.path);

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
        input.range?.end != null && input.range.end > totalLines,
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
    if (range?.end != null) {
      return range.end;
    }

    if (range?.start != null) {
      return Math.min(requestedStartLine + READ_FILE_MAX_LINES - 1, totalLines);
    }
    return totalLines;
  }

  private getAttachmentConfig(
    filePath: string,
  ): { kind: 'pdf' | 'image' | 'document'; label: string } | null {
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

    // Office documents are binary formats that cannot be read as text.
    // Return them as attachments so models with file input support can process them.
    const isDocument =
      OFFICE_EXTENSIONS.has(extension) || OFFICE_MIME_TYPES.has(mimeType ?? '');
    if (isDocument) {
      return { kind: 'document', label: 'document' };
    }

    return null;
  }

  private async returnBinaryAttachment(
    input: ReadInput,
    config: { kind: 'pdf' | 'image' | 'document'; label: string },
  ): Promise<ToolResult> {
    const copy = ATTACHMENT_COPY[config.kind];
    const descriptionLabel =
      config.kind === 'pdf'
        ? 'PDF'
        : config.kind === 'image'
          ? 'Image'
          : 'Document';
    const attachment = await buildFileAttachment({
      filePath: input.path,
      description: `${descriptionLabel} returned by read_file tool.`,
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

const OFFICE_EXTENSIONS = new Set([
  // Word processing
  '.doc',
  '.docx',
  '.odt',
  '.rtf',
  // Spreadsheets
  '.xls',
  '.xlsx',
  '.ods',
  // Presentations
  '.ppt',
  '.pptx',
  '.odp',
  // Apple iWork
  '.pages',
  '.numbers',
  '.key',
]);

const OFFICE_MIME_TYPES = new Set([
  // Word processing
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.oasis.opendocument.text',
  'application/rtf',
  'text/rtf',
  // Spreadsheets
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.spreadsheet',
  // Presentations
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.presentation',
  // Apple iWork
  'application/vnd.apple.pages',
  'application/vnd.apple.numbers',
  'application/vnd.apple.keynote',
]);

const ATTACHMENT_COPY: Record<
  'pdf' | 'image' | 'document',
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
  document: {
    rangeSummary:
      'Ignored requested line range because office documents are binary.',
    rangeOutput: 'Line ranges are not supported when reading office documents.',
    coreOutput:
      'Returned the document as a file attachment. Models with file input support can extract and analyze the document content.',
  },
};
