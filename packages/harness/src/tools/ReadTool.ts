// Third-party imports
import { Effect, FileSystem, Schema, SchemaGetter } from 'effect';

// Local imports
import { ToolContext } from '@agent/core/tools/ToolTypes';
import { recordToolFileRead } from '@agent/runtime/RunCall';
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
import { formatFileView } from '@tools/formatting';
import { parseEml, type EmlImageAttachment } from '@tools/emlParser';
import { splitContentLines } from '@utils/text/stringUtils';
import { hasExtension, getExtensionLowercase } from '@utils/core/pathCore';
import {
  getMimeType,
  isImageMimeType,
  OFFICE_EXTENSIONS,
  OFFICE_MIME_TYPES,
} from '@utils/files/mimeUtils';

// Local file imports
import { defineTool } from './core/definition';

const LineNumberSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

const RangeObjectSchema = Schema.Struct({
  start: LineNumberSchema.annotate({
    description: 'First line to read, 1-indexed.',
  }),
  end: Schema.optional(Schema.NullOr(LineNumberSchema)).annotate({
    description: 'Last line to read, inclusive and 1-indexed.',
  }),
}).check(
  Schema.makeFilter(
    (value) =>
      value.end == null ||
      value.end >= value.start || {
        path: ['end'],
        issue: 'range.end must be greater than or equal to range.start',
      },
  ),
);

/**
 * The range parameter: `{start, end}`, or the `[start, end]` array some
 * models (e.g. DeepSeek) send instead, decoded to the same object.
 */
const RangeSchema = Schema.Union([
  RangeObjectSchema,
  Schema.Tuple([
    LineNumberSchema,
    Schema.optionalKey(Schema.NullOr(LineNumberSchema)),
  ]).pipe(
    Schema.decodeTo(RangeObjectSchema, {
      decode: SchemaGetter.transform(([start, end]) => ({ start, end })),
      encode: SchemaGetter.transform(({ start, end }) => [start, end]),
    }),
  ),
]);

const ReadInputSchema = Schema.Struct({
  path: Schema.String.annotate({
    description: 'Workspace-relative or absolute file path to read.',
  }),
  range: Schema.optional(Schema.NullOr(RangeSchema)).annotate({
    description: 'Optional inclusive line range to read.',
  }),
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
  const filePath = resolved.fsPath;

  const attachmentKind = getAttachmentConfig(resolved.absolute);
  if (attachmentKind) {
    const result = yield* returnBinaryAttachment(
      input,
      attachmentKind,
      resolved,
    );
    yield* recordToolFileRead(filePath);
    return result;
  }

  // EML files use complex MIME encoding (multipart, base64, quoted-printable).
  // Parse into readable text and extract image attachments for vision models.
  let emlImages: EmlImageAttachment[] = [];
  let lines: string[];

  // The resolution already entered the call's workspace frame, so the
  // absolute path it produced is what the process filesystem reads: a
  // workspace file and one under a registered external root are the same
  // read here, through the process `FileSystem`.
  const fs = yield* FileSystem.FileSystem;
  // The file's text with LF line ends; run by whichever branch reads it.
  const readLf = fs
    .readFileString(resolved.absolute)
    .pipe(Effect.map((text: string) => text.replaceAll('\r\n', '\n')));

  if (hasExtension(input.path, '.eml')) {
    const stats = yield* fs.stat(resolved.absolute);
    // Guard against very large EML files exhausting memory during parsing.
    if (Number(stats.size) > ATTACHMENT_MAX_BYTES) {
      return yield* Effect.fail(
        new ToolError(
          `EML file exceeds maximum size of ${ATTACHMENT_MAX_BYTES.toLocaleString('en-US')} bytes.`,
        ),
      );
    }
    const { text, images } = yield* parseEml(yield* readLf);
    lines = splitContentLines(text);
    emlImages = images;
  } else {
    lines = splitContentLines(yield* readLf);
  }

  yield* recordToolFileRead(filePath);

  const range = input.range;
  const totalLines = lines.length;
  const startLine = range?.start ?? 1;
  // Pass an omitted `end` through as EOF. formatFileView owns the visible
  // line limit and needs the full requested range to report truncation.
  const endLine = range?.end ?? totalLines;

  // Append a range-exceeded warning when the caller asked beyond EOF
  const suffix =
    range?.end != null && range.end > totalLines
      ? ` (requested end ${range.end} exceeds file length ${totalLines})`
      : '';

  const result = formatFileView({
    path: displayPath,
    lines,
    viewRange: range ? [startLine, endLine] : null,
    summarySuffix: suffix,
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

  return result;
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
  ): Effect.fn.Return<ToolResult, Error, ToolContext | FileSystem.FileSystem> {
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
