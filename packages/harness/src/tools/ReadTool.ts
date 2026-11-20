// Third-party imports
import { Effect, FileSystem, Schema } from 'effect';

// Local imports
import { ToolContext } from '@tools/core/ToolTypes';
import { ToolError, type ToolResult } from '@shared/schemas';
import {
  resolveToolPath,
  type ToolPathResolution,
} from '@tools/pathResolution';
import {
  ATTACHMENT_MAX_BYTES,
  buildBytesAttachment,
  buildFileAttachment,
} from '@tools/attachments';
import { formatFileView, LineRangeSchema } from '@tools/formatting';
import { parseEml } from '@tools/emlParser';
import { readNormalizedFile } from '@utils/files/fsDurability';
import { formatCount, splitContentLines } from '@utils/text/stringUtils';
import { hasExtension, getExtensionLowercase } from '@utils/core/pathBasics';
import {
  getMimeType,
  isImageMimeType,
  OFFICE_EXTENSIONS,
  OFFICE_MIME_TYPES,
} from '@utils/files/mimeUtils';

// Local file imports
import { defineTool } from './core/definition';
import { optionalInput } from './core/inputSchema';

const ReadInputSchema = Schema.Struct({
  path: Schema.String.annotate({
    description: 'Workspace-relative or absolute file path to read.',
  }),
  range: optionalInput(
    LineRangeSchema,
    'Optional inclusive line range to read.',
  ),
});

type ReadInput = typeof ReadInputSchema.Type;

type AttachmentKind = 'pdf' | 'image' | 'document';

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

const read = Effect.fn('ReadFileTool.execute')(function* (
  input: ReadInput,
): Effect.fn.Return<ToolResult, Error, ToolContext | FileSystem.FileSystem> {
  const call = yield* ToolContext;
  const resolved = yield* resolveToolPath(call.env, input.path);
  const displayPath = resolved.display;
  // The result names the file read as an edit's result names an edited
  // file, so an edit of it later in the run finds the read in the rows.
  const reads = [displayPath];

  const attachmentKind = getAttachmentConfig(resolved.absolute);
  if (attachmentKind) {
    const result = yield* returnBinaryAttachment(
      input,
      attachmentKind,
      resolved,
    );
    return { ...result, reads };
  }

  // The resolution already entered the call's workspace frame, so the
  // absolute path it produced is what the process filesystem reads: a
  // workspace file and one under a registered external root are the same
  // read here, through the process `FileSystem`.
  const fs = yield* FileSystem.FileSystem;

  // EML files use complex MIME encoding (multipart, base64, quoted-printable).
  // Parse into readable text and extract image attachments for vision models.
  const isEml = hasExtension(input.path, '.eml');
  if (isEml) {
    const stats = yield* fs.stat(resolved.absolute);
    // Guard against very large EML files exhausting memory during parsing.
    if (Number(stats.size) > ATTACHMENT_MAX_BYTES) {
      return yield* new ToolError(
        `EML file exceeds maximum size of ${formatCount(ATTACHMENT_MAX_BYTES)} bytes.`,
      );
    }
  }
  // The same read the edit tools make, so a line read here is a line an
  // edit can match, a leading BOM included.
  const content = yield* readNormalizedFile(fs, resolved.absolute);
  // A leading BOM hides an email's headers from the MIME parser, which then
  // reads the whole message as its body.
  const { text, images: emlImages } = isEml
    ? yield* parseEml(content.replace(/^\uFEFF/, ''))
    : { text: content, images: [] };
  const lines = splitContentLines(text);

  const result = formatFileView({
    path: displayPath,
    lines,
    range: input.range,
  });

  if (emlImages.length > 0) {
    result.files = yield* Effect.forEach(emlImages, (img) =>
      buildBytesAttachment({
        path: img.filename,
        mimeType: img.mimeType,
        bytes: img.bytes,
        description: `Image attachment from email: ${img.filename}`,
      }),
    );
  }

  return { ...result, reads };
});

function getAttachmentConfig(filePath: string): AttachmentKind | null {
  const mimeType = getMimeType(filePath)?.toLowerCase();
  // Keep extension detection case-insensitive so users can reference files regardless of casing.
  const extension = getExtensionLowercase(filePath);

  if (mimeType === 'application/pdf' || extension === '.pdf') {
    return 'pdf';
  }

  // Treat SVG as an image attachment so vision-capable models can inspect its rendered appearance
  // even though the underlying file is XML text.
  if (isImageMimeType(mimeType)) {
    return 'image';
  }

  // Office documents are binary formats that cannot be read as text.
  // Return them as attachments so models with file input support can process them.
  if (
    OFFICE_EXTENSIONS.includes(extension) ||
    OFFICE_MIME_TYPES.has(mimeType ?? '')
  ) {
    return 'document';
  }

  return null;
}

const returnBinaryAttachment = Effect.fn('ReadFileTool.returnBinaryAttachment')(
  function* (
    input: ReadInput,
    kind: AttachmentKind,
    resolved: ToolPathResolution,
  ): Effect.fn.Return<
    Extract<ToolResult, { status: 'executed' }>,
    Error,
    ToolContext | FileSystem.FileSystem
  > {
    const copy = ATTACHMENT_COPY[kind];
    const attachment = yield* buildFileAttachment({
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
  },
);

export const ReadFileTool = defineTool({
  name: 'read_file',
  replay: 'safe',
  lane: 'parallel',
  description:
    'Read and return workspace files. For text files you can supply an optional line range. PDFs (.pdf) and common image formats are returned as attachments so vision-capable models can inspect their pages or visual content.',
  schema: ReadInputSchema,
  execute: read,
});
