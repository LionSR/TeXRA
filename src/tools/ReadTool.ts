// Standard library imports
import * as path from 'path';

// Third-party imports
import { z } from 'zod';

// Local imports - tools
import type { ToolResult } from '@tools/result';
import {
  buildFileAttachment,
  formatFileView,
  READ_FILE_MAX_LINES,
} from '@tools/utils';
import { recordToolFileRead } from '@tools/fileInteractions';
import {
  WorkspaceFS,
  getMimeType,
  OFFICE_EXTENSIONS,
  OFFICE_MIME_TYPES,
} from '@utils/files';
import { splitContentLines } from '@utils/text/stringUtils';

// Local file imports
import { defineTool } from './core/define';


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
    const startIndex = Math.min(requestedStartLine - 1, totalLines);
    const endIndex = Math.min(
      Math.max(requestedEndLine, requestedStartLine),
      totalLines,
    );

    // Append a range-exceeded warning when the caller asked beyond EOF
    const rangeEndExceeded =
      input.range?.end != null && input.range.end > totalLines;
    const suffix = rangeEndExceeded
      ? ` (requested end ${requestedEndLine} exceeds file length ${totalLines})`
      : '';

    const result = formatFileView({
      path: input.path,
      lines,
      startIndex,
      endIndex,
      rangeProvided: Boolean(input.range),
      summarySuffix: suffix,
    });

    return result;
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
      return { kind: 'image', label: 'Image' };
    }

    // Office documents are binary formats that cannot be read as text.
    // Return them as attachments so models with file input support can process them.
    const isDocument =
      OFFICE_EXTENSIONS.has(extension) || OFFICE_MIME_TYPES.has(mimeType ?? '');
    if (isDocument) {
      return { kind: 'document', label: 'Document' };
    }

    return null;
  }

  private async returnBinaryAttachment(
    input: ReadInput,
    config: { kind: 'pdf' | 'image' | 'document'; label: string },
  ): Promise<ToolResult> {
    const copy = ATTACHMENT_COPY[config.kind];
    const attachment = await buildFileAttachment({
      filePath: input.path,
      description: `${config.label} returned by read_file tool.`,
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
