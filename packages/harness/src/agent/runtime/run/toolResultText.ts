/**
 * The model-visible text of one tool settlement: the actionable fields of a
 * `ToolResult` as plain text (no JSON envelope), truncated head+tail past the
 * size cap, with the attachment summary a model that cannot take the bytes
 * still needs. Built from settlement evidence, never from the runtime's whole
 * mutation vocabulary.
 */
import type { ToolResult } from '@shared/schemas';
import { appendHead, appendTail } from '@utils/text/appendTail';

/** Max character length for tool result text (200KB ~ 50-66k tokens). */
const MAX_TOOL_RESULT_TEXT_LENGTH = 200_000;

/**
 * Head and tail kept when a tool result exceeds the cap, rather than dropping
 * it wholesale. Head is small (just enough to name the invoked engine/file);
 * tail is large because build errors cluster at the end of long logs.
 */
export const TOOL_RESULT_TRUNCATION_HEAD_CHARS = 4_000;
export const TOOL_RESULT_TRUNCATION_TAIL_CHARS = 50_000;

/**
 * The summary of an attachment set the model must read back itself: the list
 * of paths and MIME types, each with why it reaches the model as a mention
 * only when it does (`note`), plus the hint naming the tool that opens them.
 */
export function formatAttachmentSummary(
  attachments: readonly {
    readonly path: string;
    readonly mimeType: string;
    readonly note?: string;
  }[],
): string {
  const notes = attachments
    .map(
      (file) =>
        `- ${file.path || 'attachment'} (${file.mimeType || 'application/octet-stream'})${file.note === undefined ? '' : `: ${file.note}`}`,
    )
    .join('\n');
  return `Attachments available:\n${notes}\nUse the read_file tool to read them.`;
}

/**
 * `text` within the size cap: itself, or past the cap its head and tail
 * around an explicit elision marker. Head is small (enough to name the
 * invoked engine/file); tail is large because compiler and build errors
 * cluster at the end of long logs. Every result passes it as the model reads
 * it; a tool whose output comes from outside the process also applies it
 * before the output is stored.
 */
export function capToolResultText(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_TEXT_LENGTH) {
    return text;
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

  if (result.status === 'executed' && result.output?.trim()) {
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

  return capToolResultText(combined);
}
