// Standard library imports
import * as path from 'path';

// Local imports - core
import { z } from 'zod';

// Local imports - tools
import { ToolResult, toolResult } from '@tools/result';
import { buildFileAttachment } from '@tools/utils';
import { recordToolFileRead } from '@tools/fileInteractions';
import { WorkspaceFS, getMimeType } from '@utils/files';

// Local file imports
import { defineTool } from './core/define';

export const READ_FILE_MAX_LINES = 2000;

const ReadInputSchema = z.strictObject({
  path: z.string(),
  range: z
    .strictObject({
      start: z.int().min(1),
      end: z.int().min(1).nullish(),
    })
    .refine((value) => value.end == null || value.end >= value.start, {
      path: ['end'],
      error: 'range.end must be greater than or equal to range.start',
    })
    .nullish(),
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
      const numberedLines = this.formatWithLineNumbers(
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

    return toolResult({
      summary,
      output: segments.join('\n'),
    });
  }

  private formatWithLineNumbers(
    lines: string[],
    startingLine: number,
  ): string[] {
    const width = 6;
    return lines.map((line, index) => {
      const lineNumber = startingLine + index;
      const prefix = lineNumber.toString().padStart(width, ' ');
      return `${prefix}\t${line}`;
    });
  }

  private buildSummary({
    path,
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

  private getAttachmentConfig(
    filePath: string,
  ): { kind: 'pdf' | 'image'; label: string } | null {
    const mimeType = getMimeType(filePath)?.toLowerCase();
    const lowerPath = filePath.toLowerCase();
    // Keep extension detection case-insensitive so users can reference files regardless of casing.
    const extension = path.extname(lowerPath);

    if (mimeType === 'application/pdf' || extension === '.pdf') {
      return { kind: 'pdf', label: 'PDF' };
    }

    const isImageMime = mimeType?.startsWith('image/');
    // Treat SVG as an image attachment so vision-capable models can inspect its rendered appearance
    // even though the underlying file is XML text.
    if (isImageMime || (extension && IMAGE_EXTENSIONS.has(extension))) {
      return { kind: 'image', label: 'image' };
    }

    return null;
  }

  private async returnBinaryAttachment(
    input: ReadInput,
    config: { kind: 'pdf' | 'image'; label: string },
  ): Promise<ToolResult> {
    const attachmentCopy = ATTACHMENT_COPY[config.kind];
    const attachment = await buildFileAttachment({
      filePath: input.path,
      description:
        config.kind === 'pdf'
          ? 'PDF returned by read_file tool.'
          : 'Image returned by read_file tool.',
    });

    const summaryParts = [`Attached ${config.label} ${attachment.path}.`];
    if (input.range) {
      summaryParts.push(attachmentCopy.rangeSummary);
    }

    const outputParts: string[] = [];
    if (input.range) {
      outputParts.push(attachmentCopy.rangeOutput);
    }
    outputParts.push(attachmentCopy.coreOutput);

    return toolResult({
      summary: summaryParts.join(' '),
      output: outputParts.join(' '),
      files: [attachment],
    });
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
