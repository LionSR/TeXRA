// Node imports
import * as path from 'node:path';

// Third-party imports
import { z } from 'zod';

// Local imports
import { getCurrentToolCallContext } from '@agent/followUp/ToolFileInteractionContext';
import { ToolError, type ToolResult } from '@shared/schemas/toolResult';
import { isOversizedImage, MANY_IMAGE_MAX_DIMENSION } from '@tools/imageUtils';
import { buildFileAttachment } from '@tools/attachments';
import { formatFileView, READ_FILE_MAX_LINES } from '@tools/formatting';
import {
  resolveAndFormat,
  currentToolRoot,
  type WorkspacePathResolution,
} from '@tools/pathResolution';
import { recordToolFileRead } from '@tools/fileInteractions';
import { parseEml, type EmlImageAttachment } from '@tools/emlParser';
import { splitContentLines } from '@utils/text/stringUtils';
import { hasExtension, getExtensionLowercase } from '@utils/core/pathCore';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import {
  getMimeType,
  OFFICE_EXTENSIONS,
  OFFICE_MIME_TYPES,
} from '@utils/files/mimeUtils';

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
      start: z.int().min(1).describe('First line to read, 1-indexed.'),
      end: z
        .int()
        .min(1)
        .nullish()
        .describe('Last line to read, inclusive and 1-indexed.'),
    })

    .refine((value) => value.end == null || value.end >= value.start, {
      path: ['end'],
      error: 'range.end must be greater than or equal to range.start',
    }),
);

const ReadInputSchema = z.strictObject({
  path: z
    .string()
    .describe('Workspace-relative or absolute file path to read.'),
  range: RangeSchema.nullish().describe(
    'Optional inclusive line range to read.',
  ),
});

export type ReadInput = z.infer<typeof ReadInputSchema>;

type AttachmentKind = 'pdf' | 'image' | 'document';

export class ReadFileTool extends defineTool({
  name: 'read_file',
  parallelSafe: true,
  description:
    'Read and return workspace files. For text files you can supply an optional line range. PDFs (.pdf) and common image formats are returned as attachments so vision-capable models can inspect their pages or visual content.',
  schema: ReadInputSchema,
}) {
  protected async execute(input: ReadInput): Promise<ToolResult> {
    // Local reads finish in milliseconds, so no mid-read cancellation is
    // needed — but a queued call must not start after the batch aborted.
    if (getCurrentToolCallContext()?.signal?.aborted) {
      throw new ToolError('Cancelled before execution.');
    }
    const root = currentToolRoot();
    const { path: resolved, display: displayPath } = resolveAndFormat(
      input.path,
      root,
    );
    const filePath = resolved.fsPath;

    const attachmentKind = this.getAttachmentConfig(resolved.absolute);
    if (attachmentKind) {
      const result = await this.returnBinaryAttachment(
        input,
        attachmentKind,
        resolved,
      );
      recordToolFileRead(filePath);
      return result;
    }

    // EML files use complex MIME encoding (multipart, base64, quoted-printable).
    // Parse into readable text and extract image attachments for vision models.
    let emlImages: EmlImageAttachment[] = [];
    let lines: string[];

    if (hasExtension(input.path, '.eml')) {
      const stats = await WorkspaceFS.stat(filePath);
      if (stats.size > MAX_EML_BYTES) {
        throw new ToolError(
          `EML file exceeds maximum size of ${MAX_EML_BYTES / (1024 * 1024)} MiB.`,
        );
      }
      const raw = await WorkspaceFS.read(filePath);
      const { text, images } = await parseEml(raw);
      lines = splitContentLines(text);
      emlImages = images;
    } else {
      lines = splitContentLines(await WorkspaceFS.read(filePath));
    }

    recordToolFileRead(filePath);

    const totalLines = lines.length;
    const requestedStartLine = input.range?.start ?? 1;
    const requestedEndLine = this.computeRequestedEndLine(
      input.range,
      requestedStartLine,
      totalLines,
    );

    // Clamp the 1-based range to the file bounds so callers can safely
    // request windows beyond the file length.
    const startLine = Math.min(requestedStartLine, totalLines + 1);
    const endLine = Math.min(
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
      path: displayPath,
      lines,
      viewRange: input.range ? [startLine, endLine] : null,
      summarySuffix: suffix,
    });

    if (emlImages.length > 0) {
      result.files = emlImages.map((img) => {
        if (isOversizedImage(img.bytes)) {
          return {
            path: img.filename,
            mimeType: img.mimeType,
            description: `Image attachment from email: ${img.filename} — Image exceeds ${MANY_IMAGE_MAX_DIMENSION}px dimension limit; binary data stripped`,
          };
        }
        return {
          path: img.filename,
          mimeType: img.mimeType,
          bytes: img.bytes,
          description: `Image attachment from email: ${img.filename}`,
        };
      });
    }

    return result;
  }

  private computeRequestedEndLine(
    range: ReadInput['range'],
    requestedStartLine: number,
    totalLines: number,
  ): number {
    if (range?.end != null) return range.end;
    if (range?.start != null)
      return Math.min(requestedStartLine + READ_FILE_MAX_LINES - 1, totalLines);
    return totalLines;
  }

  private getAttachmentConfig(filePath: string): AttachmentKind | null {
    const mimeType = getMimeType(filePath)?.toLowerCase();
    // Keep extension detection case-insensitive so users can reference files regardless of casing.
    const extension = getExtensionLowercase(filePath);

    const isPdf = mimeType === 'application/pdf' || extension === '.pdf';
    if (isPdf) {
      return 'pdf';
    }

    // Treat SVG as an image attachment so vision-capable models can inspect its rendered appearance
    // even though the underlying file is XML text.
    const isImage =
      mimeType?.startsWith('image/') || IMAGE_EXTENSIONS.has(extension);
    if (isImage) {
      return 'image';
    }

    // Office documents are binary formats that cannot be read as text.
    // Return them as attachments so models with file input support can process them.
    const isDocument =
      OFFICE_EXTENSIONS.has(extension) || OFFICE_MIME_TYPES.has(mimeType ?? '');
    if (isDocument) {
      return 'document';
    }

    return null;
  }

  private async returnBinaryAttachment(
    input: ReadInput,
    kind: AttachmentKind,
    resolved: WorkspacePathResolution,
  ): Promise<ToolResult> {
    const copy = ATTACHMENT_COPY[kind];
    const attachment = await buildFileAttachment({
      filePath: resolved.fsPath,
      description: `${copy.label} returned by read_file tool.`,
      resolved,
    });

    const baseSummary = `Attached ${copy.label} ${attachment.path}.`;
    const summary = input.range
      ? `${baseSummary} ${copy.rangeSummary}`
      : baseSummary;
    const output = input.range
      ? `${copy.rangeOutput} ${copy.coreOutput}`
      : copy.coreOutput;

    return { status: 'executed', summary, output, files: [attachment] };
  }
}

/** Guard against very large EML files exhausting memory during parsing. */
const MAX_EML_BYTES = 15 * 1024 * 1024; // 15 MiB — matches DEFAULT_ATTACHMENT_MAX_BYTES

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
  AttachmentKind,
  {
    label: string;
    rangeSummary: string;
    rangeOutput: string;
    coreOutput: string;
  }
> = {
  pdf: {
    label: 'PDF',
    rangeSummary: 'Ignored requested line range because PDFs are binary.',
    rangeOutput: 'Line ranges are not supported when reading PDFs.',
    coreOutput:
      'Returned the PDF as a file attachment. Vision-capable models can analyze each page with text and visual context.',
  },
  image: {
    label: 'Image',
    rangeSummary: 'Ignored requested line range because images are binary.',
    rangeOutput: 'Line ranges are not supported when reading images.',
    coreOutput:
      'Returned the image as a file attachment. Vision-capable models can analyze the visual content directly.',
  },
  document: {
    label: 'Document',
    rangeSummary:
      'Ignored requested line range because office documents are binary.',
    rangeOutput: 'Line ranges are not supported when reading office documents.',
    coreOutput:
      'Returned the document as a file attachment. Models with file input support can extract and analyze the document content.',
  },
};
