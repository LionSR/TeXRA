// Third-party imports
import { z } from 'zod';

// Local imports - tools (single source of truth for file/attachment schemas)
import {
  type ToolFileAttachment,
  type ToolResult,
  type FileReference,
  ToolFileAttachmentSchema,
  FileReferenceSchema,
  LineChangesSchema,
  EditRecordSchema,
} from '@tools/result';

// Local imports - utils
import { isNonEmptyString } from '@utils/core';
import { WorkspaceFS } from '@utils/files';

export const DEFAULT_ATTACHMENT_MIME_TYPE = 'application/octet-stream';

// ============================================================================
// Additional Schemas (specific to tool attachment handling)
// ============================================================================

/**
 * Schema for records of files edited during tool execution.
 * Specific to logging/tracking edited files in handler context.
 */
export const EditedFileRecordSchema = z.object({
  /** Path to the edited file */
  path: z.string(),
  /** Whether the edit succeeded */
  ok: z.boolean(),
  /** Source identifier for the edit */
  source: z.string(),
  /** Human readable display name for the source */
  sourceDisplay: z.string(),
});

/**
 * Schema for strongly-typed tool result payloads sent to model handlers.
 * This is what gets passed to handlers - no binary data, properly typed fields.
 * Uses looseObject to allow additional properties for forward compatibility.
 */
export const ToolResultPayloadSchema = z.looseObject({
  /** Brief summary of the tool execution result */
  summary: z.string().optional(),
  /** Detailed output from the tool */
  output: z.string().optional(),
  /** Error message if tool execution failed */
  error: z.string().optional(),
  /** User instruction that was processed */
  userInstruction: z.string().optional(),
  /** User-provided patch content */
  userPatch: z.string().optional(),
  /** Whether this result represents an error */
  isError: z.boolean().optional(),
  /** Statistics about line changes made */
  lineChanges: LineChangesSchema.optional(),
  /** Additional diagnostic information (type varies by context) */
  diagnostics: z.unknown().optional(),
  /** Records of edits made during tool execution */
  edits: z.array(EditRecordSchema).optional(),
  /** File references (binary data stripped) */
  files: z.array(FileReferenceSchema).optional(),
  /** Files edited during tool execution (for logging/tracking) */
  editedFiles: z.array(EditedFileRecordSchema).optional(),
  /** Summary added by handlers when attachments are available */
  attachmentSummary: z.string().optional(),
});

export type ToolResultPayload = z.infer<typeof ToolResultPayloadSchema>;

/**
 * Result from extracting attachments from a tool result.
 * Simple interface - no runtime validation needed for this structure.
 */
export interface ExtractedToolAttachments {
  /** Extracted file attachments with binary data */
  attachments: ToolFileAttachment[];
  /** Sanitized result payload without binary data */
  sanitizedResult: ToolResultPayload;
}

/**
 * Type guard to check if a value is a valid ToolFileAttachment.
 * Uses Zod schema for validation.
 */
function isToolFileAttachment(value: unknown): value is ToolFileAttachment {
  return ToolFileAttachmentSchema.safeParse(value).success;
}

/**
 * Extracts file attachments from a tool result and returns a typed payload.
 * Binary data (base64Data, bytes) is stripped from the result.
 *
 * Uses Zod schema with passthrough() so parsing never fails - unknown fields
 * are preserved for forward compatibility.
 *
 * @param result - Raw tool result (may contain binary data)
 * @returns Extracted attachments and typed payload (without binary data)
 */
export function extractToolAttachments(
  result: ToolResult,
): ExtractedToolAttachments {
  // Extract attachments from files array
  const attachmentsCandidate = result.files;
  const attachments: ToolFileAttachment[] = Array.isArray(attachmentsCandidate)
    ? attachmentsCandidate.filter(isToolFileAttachment)
    : [];

  // Parse with Zod - passthrough() ensures this never fails
  const parsed = ToolResultPayloadSchema.parse(result);

  // Build sanitized result, stripping binary data and undefined values
  const sanitizedResult: ToolResultPayload = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (value === undefined) continue;
    // Skip binary fields (these belong in files array attachments)
    if (key === 'base64Data' || key === 'bytes') {
      continue;
    }
    sanitizedResult[key] = value;
  }

  // Strip binary data from file references, keep metadata
  if (attachments.length > 0) {
    sanitizedResult.files = attachments.map(
      ({ base64Data, bytes, ...rest }): FileReference => ({
        path: rest.path,
        mimeType: rest.mimeType,
        ...(rest.description ? { description: rest.description } : {}),
      }),
    );
  } else {
    // Remove files key if no valid attachments
    delete sanitizedResult.files;
  }

  return { attachments, sanitizedResult };
}

export function describeAttachments(
  attachments: ToolFileAttachment[],
): string[] {
  return attachments.map((file) => {
    const path =
      typeof file.path === 'string' && file.path.length > 0
        ? file.path
        : 'attachment';
    const type =
      typeof file.mimeType === 'string' && file.mimeType.length > 0
        ? file.mimeType
        : DEFAULT_ATTACHMENT_MIME_TYPE;
    return `- ${path} (${type})`;
  });
}

/**
 * Attachment summary message variants for different handler scenarios.
 */
export type AttachmentSummaryVariant =
  /** Handler doesn't upload files - tell model to use read_file */
  | 'metadata-only'
  /** Files were uploaded/included inline - no read instruction needed */
  | 'included-inline'
  /** Some files couldn't be uploaded - fallback to read_file */
  | 'metadata-fallback';

/**
 * Format a standardized attachment summary message.
 * Centralizes the summary text used across all handlers for consistency.
 *
 * @param attachments - File attachments to describe
 * @param variant - Which message variant to use
 * @returns Formatted summary string
 */
export function formatAttachmentSummary(
  attachments: ToolFileAttachment[],
  variant: AttachmentSummaryVariant = 'metadata-only',
): string {
  const descriptions = describeAttachments(attachments).join('\n');
  return formatAttachmentSummaryFromNotes(descriptions, variant);
}

/**
 * Format attachment summary from pre-built description notes.
 * Use this when descriptions come from multiple sources (e.g., Anthropic handler).
 */
export function formatAttachmentSummaryFromNotes(
  notes: string,
  variant: AttachmentSummaryVariant = 'metadata-only',
): string {
  switch (variant) {
    case 'included-inline':
      return `Attachments included in this response:\n${notes}`;
    case 'metadata-fallback':
      return `Attachments available but returned as metadata only:\n${notes}\nUse the read_file tool if you need the raw bytes.`;
    case 'metadata-only':
    default:
      return `Attachments available:\n${notes}\nUse the read_file tool to read them.`;
  }
}

export async function loadAttachmentBuffer(
  attachment: ToolFileAttachment,
): Promise<Buffer> {
  if (attachment.bytes && attachment.bytes.length > 0) {
    return Buffer.from(attachment.bytes);
  }

  if (attachment.base64Data && attachment.base64Data.length > 0) {
    return Buffer.from(attachment.base64Data, 'base64');
  }

  if (attachment.path && attachment.path.length > 0) {
    return WorkspaceFS.readFileBytes(attachment.path);
  }

  throw new Error('Attachment did not include bytes, base64 data, or a path.');
}

/**
 * Format tool result as plain text for sending to models.
 * Extracts only actionable fields - avoids JSON serialization to save tokens.
 *
 * Priority order:
 * 1. output (primary result content)
 * 2. userInstruction (user feedback during approval)
 * 3. error (for failed tools without output)
 * 4. summary (fallback if nothing else)
 *
 * @param result - The tool result payload
 * @param attachmentSummary - Optional attachment summary to append
 * @returns Formatted plain text string
 */
export function formatToolResultAsText(
  result: ToolResultPayload,
  attachmentSummary?: string,
): string {
  const textPieces: string[] = [];

  if (isNonEmptyString(result.output)) {
    textPieces.push(result.output);
  }
  if (result.userInstruction) {
    textPieces.push(`User feedback: ${result.userInstruction}`);
  }
  if (result.isError && !result.output && result.error) {
    textPieces.push(result.error);
  }
  if (textPieces.length === 0 && result.summary) {
    textPieces.push(result.summary);
  }
  if (attachmentSummary) {
    textPieces.push(attachmentSummary);
  }

  // 'OK' fallback is defensive - only triggers if tool sets no output, summary,
  // error, userInstruction, or attachmentSummary. All current tools set at least summary.
  return textPieces.join('\n\n') || 'OK';
}
