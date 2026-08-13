// Local imports - tools (single source of truth for file/attachment schemas)
import { type ToolFileAttachment, type ToolResult } from '@shared/schemas';

// Local imports - utils
import { isNonEmptyString } from '@utils/core';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { appendHead, appendTail } from '@utils/text/appendTail';

// Local imports - model handlers
import {
  MAX_TOOL_RESULT_TEXT_LENGTH,
  TOOL_RESULT_TRUNCATION_HEAD_CHARS,
  TOOL_RESULT_TRUNCATION_TAIL_CHARS,
} from '../contextManagementConstants';

export const DEFAULT_ATTACHMENT_MIME_TYPE = 'application/octet-stream';

export function describeAttachments(
  attachments: ToolFileAttachment[],
): string[] {
  return attachments.map((file) => {
    const filePath = file.path || 'attachment';
    const mimeType = file.mimeType || DEFAULT_ATTACHMENT_MIME_TYPE;
    return `- ${filePath} (${mimeType})`;
  });
}

/**
 * Attachment summary message variants for different handler scenarios.
 */
type AttachmentSummaryVariant =
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

/**
 * Securely zero a sensitive attachment buffer and drop the reference. Returns
 * `undefined` so callers can wipe and release in a single expression:
 * `buffer = wipeBuffer(buffer);`
 */
export function wipeBuffer(buffer: Buffer | undefined): undefined {
  buffer?.fill(0);
  return undefined;
}

/** A single uploaded attachment, in the shape common to every provider's
 * upload result: the source attachment plus the id it was uploaded under. */
interface UploadedAttachmentBase {
  attachment: ToolFileAttachment;
  fileId: string;
}

/**
 * Runs a provider's upload call, then folds the uploaded set into a
 * `finalResult.files` copy of `result` — the block every handler's
 * tool-result follow-up path (Anthropic's `buildToolResultBlock`, OpenAI
 * Responses' `createToolUseFollowUpMessages`) repeated identically. Each
 * provider's actual upload call has its own signature and return shape
 * (Anthropic's also reports `unsupported`/`pageLimitExceeded`; OpenAI's does
 * not), so `upload` is the caller's own closure and its full return value is
 * handed back untouched for the caller to destructure further.
 */
export async function uploadAndRecordToolAttachments<
  TUploadResult extends { uploaded: UploadedAttachmentBase[] },
>(
  result: ToolResult,
  canUpload: boolean,
  upload: () => Promise<TUploadResult>,
): Promise<{
  finalResult: ToolResult;
  uploadResult: TUploadResult | undefined;
}> {
  const finalResult: ToolResult = { ...result };

  if (!canUpload) {
    return { finalResult, uploadResult: undefined };
  }

  const uploadResult = await upload();

  if (result.status === 'executed' && uploadResult.uploaded.length > 0) {
    finalResult.files = uploadResult.uploaded.map(({ attachment, fileId }) => ({
      path: attachment.path,
      mimeType: attachment.mimeType,
      description: attachment.description,
      fileId,
    })) as typeof finalResult.files;
  }

  return { finalResult, uploadResult };
}

export async function loadAttachmentBuffer(
  attachment: ToolFileAttachment,
): Promise<Buffer> {
  if (attachment.bytes?.length) {
    return Buffer.from(attachment.bytes);
  }
  if (attachment.base64Data?.length) {
    return Buffer.from(attachment.base64Data, 'base64');
  }
  if (attachment.path?.length) {
    return WorkspaceFS.readBytes(attachment.path);
  }
  throw new Error('Attachment did not include bytes, base64 data, or a path.');
}

/**
 * Fixed textual overhead of the message template below (labels, punctuation,
 * the elision marker, and the character-count numbers themselves) reserved
 * out of `maxLength` so head+tail content plus framing never balloons past
 * the caller's requested limit.
 */
const TRUNCATION_FRAME_OVERHEAD_CHARS = 300;

/**
 * Check if tool result text exceeds the maximum allowed length. Returns a
 * head+tail replacement (with an explicit elision marker) if exceeded,
 * otherwise returns null so the caller keeps the original text.
 *
 * Head is small (enough to name the invoked engine/file); tail is large
 * because LaTeX/build errors cluster at the end of long logs — dropping the
 * entire result (the prior behavior) left repair agents with no error text
 * on exactly the runs that most needed it.
 *
 * The returned string is always bounded by `maxLength`: the default head/tail
 * budgets (`TOOL_RESULT_TRUNCATION_HEAD_CHARS`/`_TAIL_CHARS`) are scaled down
 * whenever a smaller custom `maxLength` can't fit them, and a defensive
 * hard-trim guarantees the invariant even for `maxLength` values too small to
 * fit the message template itself.
 *
 * @param text - The text to check
 * @param maxLength - Maximum allowed length (default: MAX_TOOL_RESULT_TEXT_LENGTH)
 * @returns Truncated head+tail replacement if limit exceeded, null otherwise
 */
export function checkToolResultTextLimit(
  text: string,
  maxLength: number = MAX_TOOL_RESULT_TEXT_LENGTH,
): string | null {
  if (text.length <= maxLength) {
    return null;
  }

  // `text.length > maxLength` here, so `contentBudget < maxLength < text.length`
  // — this keeps headLen/tailLen strictly below text.length below, which in
  // turn keeps elidedChars > 0 (no more "0 characters elided" on near-boundary
  // sizes where the head budget alone would otherwise cover the whole text).
  const contentBudget = Math.max(
    0,
    maxLength - TRUNCATION_FRAME_OVERHEAD_CHARS,
  );
  const headBudget = Math.min(TOOL_RESULT_TRUNCATION_HEAD_CHARS, contentBudget);
  const tailBudget = Math.min(
    TOOL_RESULT_TRUNCATION_TAIL_CHARS,
    contentBudget - headBudget,
  );

  const headLen = Math.min(headBudget, text.length);
  const tailLen = Math.min(tailBudget, text.length - headLen);
  const head = appendHead('', text, headLen);
  const tail = tailLen > 0 ? appendTail('', text, tailLen) : '';
  const elidedChars = text.length - head.length - tail.length;

  const message =
    `Tool result too large: ${text.length.toLocaleString()} characters ` +
    `(limit: ${maxLength.toLocaleString()}). Showing the first ${head.length.toLocaleString()} ` +
    `and last ${tail.length.toLocaleString()} characters.\n\n` +
    `${head}\n\n[... ${elidedChars.toLocaleString()} characters elided ...]\n\n${tail}`;

  // Defensive backstop: TRUNCATION_FRAME_OVERHEAD_CHARS is an estimate, not an
  // exact accounting of the template above, so hard-trim as a last resort to
  // guarantee the maxLength invariant for every input — including maxLength
  // values too small to fit the template text at all.
  return message.length > maxLength
    ? appendHead('', message, maxLength)
    : message;
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
  result: ToolResult,
  attachmentSummary?: string,
): string {
  const textPieces: string[] = [];

  // Primary output text, present on the executed variant only.
  if (result.status === 'executed' && isNonEmptyString(result.output)) {
    textPieces.push(result.output);
  }

  // userPatch / userInstruction are shared fields on both variants. userPatch
  // captures user modifications to tool proposals (distinct from userDiffNote,
  // which only shows merge conflicts); include it when the user modified the
  // proposed edit.
  if (result.userPatch) {
    textPieces.push(
      `User modifications:\n\`\`\`diff\n${result.userPatch}\n\`\`\``,
    );
  }
  if (result.userInstruction) {
    textPieces.push(`User feedback: ${result.userInstruction}`);
  }

  if (result.status === 'error') {
    // Error variant: error is a required non-empty string, no output/summary.
    textPieces.push(result.error);
  } else if (textPieces.length === 0 && result.summary) {
    // Fallback to summary when no output text was produced.
    textPieces.push(result.summary);
  }

  if (attachmentSummary) {
    textPieces.push(attachmentSummary);
  }

  // 'OK' fallback is defensive - only triggers if tool sets no output, summary,
  // error, userInstruction, or attachmentSummary. All current tools set at least summary.
  const combined = textPieces.join('\n\n') || 'OK';

  // Truncate with a head+tail replacement if the result exceeds the limit.
  return checkToolResultTextLimit(combined) ?? combined;
}

/**
 * Build the plain-text tool-result body for chat-style handlers (OpenAI,
 * OpenRouter), appending the standard metadata attachment summary when the
 * handler can surface tool-result attachments and any are present.
 *
 * Shared by each handler's single and batched follow-up paths so the two can't
 * drift: the batched paths previously inlined `formatToolResultAsText(result)`
 * without the summary, so parallel tool calls silently dropped their attachment
 * summaries. Routing both paths through one helper makes that class of bug
 * structurally impossible.
 */
export function formatToolResultTextWithAttachments(
  result: ToolResult,
  attachments: ToolFileAttachment[],
  canProcessAttachments: boolean,
): string {
  const attachmentSummary =
    canProcessAttachments && attachments.length > 0
      ? formatAttachmentSummary(attachments)
      : undefined;
  return formatToolResultAsText(result, attachmentSummary);
}
