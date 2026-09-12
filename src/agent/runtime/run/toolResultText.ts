/**
 * The model-visible text of one tool settlement: the actionable fields of a
 * `ToolResult` as plain text (no JSON envelope), truncated head+tail past the
 * size cap, with the attachment summary a model that cannot take the bytes
 * still needs. Built from settlement evidence, never from the runtime's whole
 * mutation vocabulary.
 */
import type { ToolFileAttachment, ToolResult } from '@shared/schemas';
import { isNonEmptyString } from '@utils/core';
import { appendHead, appendTail } from '@utils/text/appendTail';

/** Max character length for tool result text (200KB ~ 50-66k tokens). */
const MAX_TOOL_RESULT_TEXT_LENGTH = 200_000;

/**
 * Head and tail kept when a tool result exceeds the cap, rather than dropping
 * it wholesale. Head is small (just enough to name the invoked engine/file);
 * tail is large because LaTeX/build errors cluster at the end of long logs.
 */
export const TOOL_RESULT_TRUNCATION_HEAD_CHARS = 4_000;
export const TOOL_RESULT_TRUNCATION_TAIL_CHARS = 50_000;

const DEFAULT_ATTACHMENT_MIME_TYPE = 'application/octet-stream';

function describeAttachments(
  attachments: readonly ToolFileAttachment[],
): string[] {
  return attachments.map((file) => {
    const filePath = file.path || 'attachment';
    const mimeType = file.mimeType || DEFAULT_ATTACHMENT_MIME_TYPE;
    return `- ${filePath} (${mimeType})`;
  });
}

type AttachmentSummaryVariant =
  'metadata-only' | 'included-inline' | 'metadata-fallback';

function formatAttachmentSummary(
  attachments: readonly ToolFileAttachment[],
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

function formatAttachmentSummaryFromNotes(
  notes: string,
  variant: AttachmentSummaryVariant = 'metadata-only',
): string {
  const header = ATTACHMENT_SUMMARY_TEMPLATES[variant];
  const hint = variant !== 'included-inline' ? `\n${READ_FILE_HINT}` : '';
  return `${header}\n${notes}${hint}`;
}

/**
 * Check if tool result text exceeds the maximum allowed length. Returns a
 * head+tail replacement (with an explicit elision marker) if exceeded,
 * otherwise null so the caller keeps the original text. Head is small
 * (enough to name the invoked engine/file); tail is large because LaTeX and
 * build errors cluster at the end of long logs.
 */
function checkToolResultTextLimit(text: string): string | null {
  if (text.length <= MAX_TOOL_RESULT_TEXT_LENGTH) {
    return null;
  }

  const head = appendHead('', text, TOOL_RESULT_TRUNCATION_HEAD_CHARS);
  const tail = appendTail('', text, TOOL_RESULT_TRUNCATION_TAIL_CHARS);
  const elidedChars = text.length - head.length - tail.length;

  const message =
    `Tool result too large: ${text.length.toLocaleString()} characters ` +
    `(limit: ${MAX_TOOL_RESULT_TEXT_LENGTH.toLocaleString()}). Showing the first ${head.length.toLocaleString()} ` +
    `and last ${tail.length.toLocaleString()} characters.\n\n` +
    `${head}\n\n[... ${elidedChars.toLocaleString()} characters elided ...]\n\n${tail}`;

  return message.length > MAX_TOOL_RESULT_TEXT_LENGTH
    ? appendHead('', message, MAX_TOOL_RESULT_TEXT_LENGTH)
    : message;
}

/**
 * Format a tool result as plain text for the model. Priority: output, then
 * the user's patch and feedback from approval, then the error of a failed
 * tool, then the summary as a fallback; the attachment summary last.
 */
export function formatToolResultAsText(
  result: ToolResult,
  attachmentSummary?: string,
): string {
  const textPieces: string[] = [];

  if (result.status === 'executed' && isNonEmptyString(result.output)) {
    textPieces.push(result.output);
  }

  // userPatch / userInstruction are shared fields on both variants. userPatch
  // captures user modifications to tool proposals (distinct from userDiffNote,
  // which only shows merge conflicts).
  if (result.userPatch) {
    textPieces.push(
      `User modifications:\n\`\`\`diff\n${result.userPatch}\n\`\`\``,
    );
  }
  if (result.userInstruction) {
    textPieces.push(`User feedback: ${result.userInstruction}`);
  }

  if (result.status === 'error') {
    textPieces.push(result.error);
  } else if (textPieces.length === 0 && result.summary) {
    textPieces.push(result.summary);
  }

  if (attachmentSummary) {
    textPieces.push(attachmentSummary);
  }

  // 'OK' fallback is defensive: it triggers only if a tool sets no output,
  // summary, error, userInstruction, or attachmentSummary.
  const combined = textPieces.join('\n\n') || 'OK';

  return checkToolResultTextLimit(combined) ?? combined;
}

/**
 * The plain-text tool-result body with the attachment summary appended when
 * the model can surface attachments and any are present. Shared by every
 * caller so the single and batched paths cannot drift.
 */
export function formatToolResultTextWithAttachments(
  result: ToolResult,
  attachments: readonly ToolFileAttachment[],
  canProcessAttachments: boolean,
): string {
  const attachmentSummary =
    canProcessAttachments && attachments.length > 0
      ? formatAttachmentSummary(attachments)
      : undefined;
  return formatToolResultAsText(result, attachmentSummary);
}
