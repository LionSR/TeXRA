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
  DIAGNOSTIC_TYPE_VALIDATION_ERROR,
} from '@tools/result';

// Local imports - model handlers
import { MAX_TOOL_RESULT_TEXT_LENGTH } from '../contextManagementConstants';

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

  // Build sanitized result, stripping binary data, undefined values, and redundant error fields
  const sanitizedResult: ToolResultPayload = {};
  const hasError = typeof parsed.error === 'string' && parsed.error.length > 0;

  for (const [key, value] of Object.entries(parsed)) {
    if (value === undefined) continue;
    // Skip binary fields (these belong in files array attachments)
    if (key === 'base64Data' || key === 'bytes') {
      continue;
    }
    // Skip isError when error message is present (redundant)
    if (key === 'isError' && hasError) {
      continue;
    }
    // Simplify diagnostics: keep validation error details, remove verbose stack traces
    if (key === 'diagnostics' && value && typeof value === 'object') {
      const diag = value as Record<string, unknown>;
      // For validation errors, keep the formatted details (useful for model)
      if (diag.type === DIAGNOSTIC_TYPE_VALIDATION_ERROR && diag.formatted) {
        sanitizedResult[key] = { type: diag.type, formatted: diag.formatted };
        continue;
      }
      // For regular errors (ToolError), skip diagnostics entirely - the error
      // message is already in the error field, and the stack trace just repeats it
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
    const filePath = isNonEmptyString(file.path) ? file.path : 'attachment';
    const mimeType = isNonEmptyString(file.mimeType)
      ? file.mimeType
      : DEFAULT_ATTACHMENT_MIME_TYPE;
    return `- ${filePath} (${mimeType})`;
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

const ATTACHMENT_SUMMARY_TEMPLATES: Record<AttachmentSummaryVariant, string> = {
  'included-inline': 'Attachments included in this response:',
  'metadata-fallback': 'Attachments available but returned as metadata only:',
  'metadata-only': 'Attachments available:',
};

const READ_FILE_HINT = 'Use the read_file tool to read them.';

/**
 * Format attachment summary from pre-built description notes.
 * Use this when descriptions come from multiple sources (e.g., Anthropic handler).
 */
export function formatAttachmentSummaryFromNotes(
  notes: string,
  variant: AttachmentSummaryVariant = 'metadata-only',
): string {
  const header = ATTACHMENT_SUMMARY_TEMPLATES[variant];
  const hint = variant !== 'included-inline' ? `\n${READ_FILE_HINT}` : '';
  return `${header}\n${notes}${hint}`;
}

export async function loadAttachmentBuffer(
  attachment: ToolFileAttachment,
): Promise<Buffer> {
  if (attachment.bytes?.length) return Buffer.from(attachment.bytes);
  if (attachment.base64Data?.length)
    return Buffer.from(attachment.base64Data, 'base64');
  if (attachment.path?.length)
    return WorkspaceFS.readFileBytes(attachment.path);

  throw new Error('Attachment did not include bytes, base64 data, or a path.');
}

/**
 * Check if tool result text exceeds the maximum allowed length.
 * Returns an error message if exceeded, otherwise returns null.
 *
 * @param text - The text to check
 * @param maxLength - Maximum allowed length (default: MAX_TOOL_RESULT_TEXT_LENGTH)
 * @returns Error message if limit exceeded, null otherwise
 */
export function checkToolResultTextLimit(
  text: string,
  maxLength: number = MAX_TOOL_RESULT_TEXT_LENGTH,
): string | null {
  if (text.length <= maxLength) {
    return null;
  }

  const exceededBy = text.length - maxLength;
  return (
    `Tool result too large: ${text.length.toLocaleString()} characters ` +
    `(limit: ${maxLength.toLocaleString()}, exceeded by ${exceededBy.toLocaleString()}). ` +
    `The output was not included to prevent context window overflow.`
  );
}

/**
 * Format tool result as plain text for sending to models.
 * Extracts only actionable fields - avoids JSON serialization to save tokens.
 * Truncates output if it exceeds MAX_TOOL_RESULT_TEXT_LENGTH to prevent context overflow.
 *
 * Priority order:
 * 1. output (primary result content)
 * 2. userInstruction (user feedback during approval)
 * 3. error (for failed tools without output)
 * 4. summary (fallback if nothing else)
 *
 * @param result - The tool result payload
 * @param attachmentSummary - Optional attachment summary to append
 * @returns Formatted plain text string (truncated if exceeds limit)
 */
export function formatToolResultAsText(
  result: ToolResultPayload,
  attachmentSummary?: string,
): string {
  const textPieces: string[] = [];

  if (isNonEmptyString(result.output)) {
    textPieces.push(result.output);
  }
  // userPatch captures user modifications to tool proposals (distinct from userDiffNote
  // which only shows merge conflicts). Include when user modified the proposed edit.
  if (result.userPatch) {
    textPieces.push(
      `User modifications:\n\`\`\`diff\n${result.userPatch}\n\`\`\``,
    );
  }
  if (result.userInstruction) {
    textPieces.push(`User feedback: ${result.userInstruction}`);
  }
  // Include error when no meaningful output - check for non-empty error string
  // rather than isError flag (which may be stripped by extractToolAttachments)
  if (isNonEmptyString(result.error) && !isNonEmptyString(result.output)) {
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
  const combined = textPieces.join('\n\n') || 'OK';

  // Check if result exceeds maximum length - return error message if so
  const limitError = checkToolResultTextLimit(combined);
  if (limitError) {
    return limitError;
  }

  return combined;
}
