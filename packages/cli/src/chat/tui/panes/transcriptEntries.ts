import stripAnsi from 'strip-ansi';

import {
  rowHeadline,
  type TranscriptRowKind,
} from '@texra-ai/harness/transcript';
import {
  ANSI_ESCAPE_START,
  ansiEscapeEnd,
} from '@cli/runtime/terminal/ansiEscapes';
import { safeTerminalText } from '@cli/runtime/terminal/terminalText';
import type { TranscriptRow } from '@cli/chat/tui/state/sessionView';
import { errorRowText, quotaFallbackNoticeText } from '@ui/copy/modelAccess';

import { normalizeKnownHtmlForCliMarkdown } from '../render/htmlMarkdownNormalize';

const INQUIRY_CONTINUATION_RE =
  /^\[inquiry\]\s+\S+\s+(?:answered|dropped by user)\.(?:\n|$)/;
const INVISIBLE_TRANSCRIPT_CHARS = new Set([
  '\u200B',
  '\u200C',
  '\u200D',
  '\uFEFF',
]);

function isInvisibleTranscriptChar(char: string | undefined): boolean {
  return char !== undefined && INVISIBLE_TRANSCRIPT_CHARS.has(char);
}

function terminalVisibleTranscriptText(text: string): string {
  let out = '';
  for (const char of stripAnsi(text)) {
    if (!isInvisibleTranscriptChar(char)) out += char;
  }
  return out;
}

export function isInquiryContinuationText(text: string): boolean {
  return INQUIRY_CONTINUATION_RE.test(text);
}

function trimAssistantTranscriptLead(text: string): string {
  let index = 0;
  let consumedInvisibleLead = false;
  let leadingAnsi = '';
  while (index < text.length) {
    if (text[index] === ANSI_ESCAPE_START) {
      const end = ansiEscapeEnd(text, index);
      leadingAnsi += text.slice(index, end);
      index = end;
      continue;
    }
    if (isInvisibleTranscriptChar(text[index])) {
      index += 1;
      consumedInvisibleLead = true;
      continue;
    }
    const newline = /^[ \t]*\r?\n/.exec(text.slice(index));
    if (newline) {
      index += newline[0].length;
      consumedInvisibleLead = true;
      continue;
    }
    break;
  }
  if (!consumedInvisibleLead) return text;
  const tail = text.slice(index);
  return terminalVisibleTranscriptText(tail).trim().length > 0
    ? leadingAnsi + tail
    : tail;
}

/**
 * The headline a row leads with: the one line its terminal paint starts from.
 * Body lines come from the row itself (`transcriptRowBodyLines`) at the
 * painter's own width — nothing is cut here.
 *
 * Memoized on the row object, which the session view replaces (never mutates) when its
 * content changes, so a hit is always current and a dropped row takes its
 * cache slot with it. Without the memo the renderable/split/scan walks would
 * re-run the markdown normalize and terminal-sanitize passes for every row on every
 * frame.
 */
const HEADLINE_CACHE = new WeakMap<TranscriptRow, string>();

export function transcriptRowHeadline(row: TranscriptRow): string {
  const cached = HEADLINE_CACHE.get(row);
  if (cached !== undefined) return cached;
  const headline = deriveTranscriptRowHeadline(row);
  HEADLINE_CACHE.set(row, headline);
  return headline;
}

/** The shared {@link rowHeadline}, sanitized for the terminal where a row
 *  carries model or process text. The one HTML normalize pass for transcript
 *  markdown runs here; the renderer does not repeat it. */
function deriveTranscriptRowHeadline(row: TranscriptRow): string {
  switch (row.kind) {
    case 'assistant':
      return normalizeKnownHtmlForCliMarkdown(
        trimAssistantTranscriptLead(row.text.full),
      );
    case 'log':
      return safeTerminalText(
        normalizeKnownHtmlForCliMarkdown(
          trimAssistantTranscriptLead(row.text.full),
        ),
      );
    case 'error':
      return safeTerminalText(errorRowText(row).summary);
    case 'progressStatus':
      return safeTerminalText(
        row.quotaFallback === undefined
          ? row.summary.full
          : quotaFallbackNoticeText(row.quotaFallback),
      );
    default:
      return rowHeadline(row);
  }
}

/**
 * Row kinds the terminal paints as a typed widget rather than as a headline,
 * so an empty headline is not an empty row: an attachment load and a compact
 * detail row are rows because the projector said so, and the terminal never
 * re-decides membership (a file list whose entries all failed to load is
 * exactly the case a reader must see). Exhaustive by construction, so a new
 * row kind has to state which side it is on.
 */
const ROW_KIND_IS_WIDGET = {
  assistant: false,
  compactionActivity: false,
  error: false,
  log: false,
  user: false,
  contextManagement: true,
  fileList: true,
  progressStatus: true,
  scratchpad: true,
  thinking: true,
  tool: true,
  webSearch: true,
} as const satisfies Record<TranscriptRowKind, boolean>;

export function isRenderableTranscriptEntry(row: TranscriptRow): boolean {
  if (ROW_KIND_IS_WIDGET[row.kind]) return true;
  return (
    terminalVisibleTranscriptText(transcriptRowHeadline(row)).trim().length > 0
  );
}

/** Whether the row at `index` is inside the session view's settled prefix
 *  (`transcript.settledRows`), the one rule for what append-only
 *  scrollback may print. */
function isFinalizedTranscriptRow(index: number, settledRows: number): boolean {
  return index < settledRows;
}

/** Callers gate on {@link isRenderableTranscriptEntry} before asking. */
function userPromptAwaitsLiveContinuation(
  rows: readonly TranscriptRow[],
  index: number,
  working: boolean,
): boolean {
  const row = rows[index];
  if (
    row?.kind !== 'user' ||
    isInquiryContinuationText(transcriptRowHeadline(row)) ||
    !working
  ) {
    return false;
  }
  return !rows.some(
    (later, laterIndex) =>
      laterIndex > index && isRenderableTranscriptEntry(later),
  );
}

/**
 * The settled rows from `from` on that scrollback prints, in the session
 * view's own order (its `settledRows` prefix is print order), and how far the
 * walk got: past every row printed or passed over, stopping at the end of the
 * settled prefix or at a user prompt still waiting for its live continuation,
 * which the next walk starts from.
 */
export function printableSettledRows(
  rows: readonly TranscriptRow[],
  from: number,
  settledRows: number,
  working: boolean,
): { readonly rows: readonly TranscriptRow[]; readonly through: number } {
  const printable: TranscriptRow[] = [];
  let through = from;
  for (; through < Math.min(settledRows, rows.length); through += 1) {
    const row = rows[through];
    if (!isRenderableTranscriptEntry(row)) continue;
    if (userPromptAwaitsLiveContinuation(rows, through, working)) break;
    printable.push(row);
  }
  return { rows: printable, through };
}

/**
 * Non-finalized entries in original stream order — the live pane's rows. The
 * renderer must walk this list (rather than rendering tool rows and the live
 * assistant as separate buckets) so that text emitted before a tool call
 * appears above the tool row instead of below it. Tool entries defer
 * finalization until the stream itself finalizes — promoting them earlier
 * would let a fast tool jump ahead of still-streaming assistant text in
 * `<Static>` scrollback, where insertion order is fixed. The complement (the
 * settled prefix) is {@link printableSettledRows}.
 */
export function pendingTranscriptEntries(
  entries: readonly TranscriptRow[],
  settledRows: number,
  working: boolean,
): TranscriptRow[] {
  const showLiveAssistant = working;
  const pending: TranscriptRow[] = [];
  for (const [index, entry] of entries.entries()) {
    if (!isRenderableTranscriptEntry(entry)) continue;
    if (userPromptAwaitsLiveContinuation(entries, index, working)) {
      pending.push(entry);
      continue;
    }
    // The settled prefix is scrollback's; everything past it is live, and a
    // row behind an unsettled one stays visible here rather than vanishing
    // between the two panes.
    if (isFinalizedTranscriptRow(index, settledRows)) continue;
    if (
      (entry.kind === 'assistant' || entry.kind === 'log') &&
      !showLiveAssistant
    ) {
      continue;
    }
    pending.push(entry);
  }
  return pending;
}
