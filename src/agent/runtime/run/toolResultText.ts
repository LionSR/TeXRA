/**
 * The model-visible text of one tool settlement: the actionable fields of a
 * `ToolResult` as plain text (no JSON envelope), truncated head+tail past the
 * size cap, with the attachment summary a model that cannot take the bytes
 * still needs. Built from settlement evidence, never from the runtime's whole
 * mutation vocabulary.
 */
import type { ToolFileAttachment, ToolResult } from '@shared/schemas';
import { isNonEmptyString } from '@utils/text/stringUtils';
import { appendHead, appendTail } from '@utils/text/appendTail';

/** Max character length for tool result text (200KB ~ 50-66k tokens). */
export const MAX_TOOL_RESULT_TEXT_LENGTH = 200_000;

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

/**
 * The summary of an attachment set the model must read back itself: the list
 * of paths and MIME types, plus the hint naming the tool that opens them.
 */
export function formatAttachmentSummary(
  attachments: readonly ToolFileAttachment[],
): string {
  const notes = describeAttachments(attachments).join('\n');
  return `Attachments available:\n${notes}\nUse the read_file tool to read them.`;
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
 * the user's feedback from approval, then the error of a failed
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

  // A user's edit to an approved write reaches the model once, inside the
  // tool's own output (`appendApprovalDiffNote`); only feedback rides here.
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
