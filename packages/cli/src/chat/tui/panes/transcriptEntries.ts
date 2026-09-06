import stripAnsi from 'strip-ansi';

import { ANSI_ESCAPE_START, ansiEscapeEnd } from '@cli/runtime/ansiEscapes';
import { safeTerminalText } from '@cli/runtime/terminalText';
import { redactSecrets } from '@logger/redaction';
import { type StreamPhase } from '@shared/schemas';
import { type TranscriptRow, type TranscriptRowKind } from '@shared/transcript';
import { isActivePhase } from '@shared/streams/streamStatus';

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
 * Memoized on the row object, which the fold replaces (never mutates) when its
 * content changes, so a hit is always current and a dropped row takes its
 * cache slot with it. Without the memo the renderable/split/scan walks would
 * re-run the markdown normalize and redaction passes for every row on every
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

function deriveTranscriptRowHeadline(row: TranscriptRow): string {
  switch (row.kind) {
    case 'assistant':
      return normalizeKnownHtmlForCliMarkdown(
        trimAssistantTranscriptLead(row.text.full),
      );
    case 'log':
      return redactSecrets(
        safeTerminalText(
          normalizeKnownHtmlForCliMarkdown(
            trimAssistantTranscriptLead(row.text.full),
          ),
        ),
      );
    // Detail rows lead with a bare noun; their `●` marker is layout geometry
    // (ROW_GEOMETRY), not part of the text.
    case 'thinking':
      return 'Thinking';
    case 'scratchpad':
      return 'Scratchpad';
    case 'user':
      return row.summary.full;
    case 'error':
      return redactSecrets(safeTerminalText(row.summary.full));
    case 'tool':
      return '';
    case 'webSearch':
    case 'webFetch':
      return row.label;
    case 'fileList':
    case 'missingOutputs':
      return row.summary;
    case 'latexdiff':
      return `Latexdiff results (${row.entries.length})`;
    case 'statistics':
    case 'contextManagement':
    case 'compactionActivity':
      return row.label;
    case 'progressStatus':
      return safeTerminalText(row.summary.full);
    case 'workflowTask':
      return row.line;
    case 'phase':
      return row.heading;
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
  phase: false,
  user: false,
  workflowTask: false,
  contextManagement: true,
  fileList: true,
  latexdiff: true,
  missingOutputs: true,
  progressStatus: true,
  scratchpad: true,
  statistics: true,
  thinking: true,
  tool: true,
  webFetch: true,
  webSearch: true,
} as const satisfies Record<TranscriptRowKind, boolean>;

export function isRenderableTranscriptEntry(row: TranscriptRow): boolean {
  if (ROW_KIND_IS_WIDGET[row.kind]) return true;
  return (
    terminalVisibleTranscriptText(transcriptRowHeadline(row)).trim().length > 0
  );
}

/** Whether the row at `index` is inside the fold's settled prefix
 *  (`transcript.settledRows`, PRD 5.1), the one rule for what append-only
 *  scrollback may print. */
function isFinalizedTranscriptRow(index: number, settledRows: number): boolean {
  return index < settledRows;
}

/** Callers gate on {@link isRenderableTranscriptEntry} before asking. */
function userPromptAwaitsLiveContinuation(
  rows: readonly TranscriptRow[],
  index: number,
  status: StreamPhase | undefined,
): boolean {
  const row = rows[index];
  if (
    row?.kind !== 'user' ||
    isInquiryContinuationText(transcriptRowHeadline(row)) ||
    !isActivePhase(status)
  ) {
    return false;
  }
  return !rows.some(
    (later, laterIndex) =>
      laterIndex > index && isRenderableTranscriptEntry(later),
  );
}

/** `(settlement order, local-after-source tiebreak)` sort key for one row. */
function transcriptOrderKey(
  row: TranscriptRow,
  index: number,
): readonly [seq: number, local: number] {
  const seq = row.settlementSeqNo ?? row.seqNo ?? index + 1;
  return [seq, row.origin === 'local' ? 1 : 0];
}

function compareTranscriptOrderKeys(
  left: readonly [number, number],
  right: readonly [number, number],
): number {
  return left[0] - right[0] || left[1] - right[1];
}

/**
 * Candidates already in settlement order, else stably sorted into it. Used
 * identically by the append-only scan and its rebuild oracle so the two
 * paths can never disagree on scrollback order.
 */
function inSettlementOrder<
  T extends {
    readonly index: number;
    readonly key: readonly [number, number];
  },
>(items: readonly T[]): readonly T[] {
  return items.every(
    (c, i) =>
      i === 0 || compareTranscriptOrderKeys(items[i - 1]!.key, c.key) <= 0,
  )
    ? items
    : items.toSorted(
        (l, r) => compareTranscriptOrderKeys(l.key, r.key) || l.index - r.index,
      );
}

/**
 * Printable rows in their append-only scrollback order.
 *
 * Source-backed rows use the durable order in which they became immutable.
 * Synthetic rows retain the settlement cursor captured when the CLI appended
 * them, with their original array position as the final stable tie-breaker.
 * Consumers that place rows relative to `<Static>` output must use this same
 * order rather than the stream's mutable storage order.
 *
 * Runs on every stream-sync tick, and entries arrive in settlement order on
 * all but the rare reorder — so it skips the O(n log n) sort whenever the
 * filtered slice is already ordered, at the cost of one O(n) pass over it.
 */
export function orderedStaticTranscriptEntries(
  entries: readonly TranscriptRow[],
  settledRows: number,
  status: StreamPhase | undefined,
): readonly TranscriptRow[] {
  const candidates: Array<{
    entry: TranscriptRow;
    index: number;
    key: readonly [number, number];
  }> = [];
  for (const [index, entry] of entries.entries()) {
    // Finalized, renderable, and not a user prompt still awaiting its live
    // continuation: the three conditions for append-only scrollback.
    if (!isFinalizedTranscriptRow(index, settledRows)) break;
    if (!isRenderableTranscriptEntry(entry)) continue;
    if (userPromptAwaitsLiveContinuation(entries, index, status)) continue;
    candidates.push({ entry, index, key: transcriptOrderKey(entry, index) });
  }

  return inSettlementOrder(candidates).map(({ entry }) => entry);
}

/**
 * Non-finalized entries in original stream order — the live pane's rows. The
 * renderer must walk this list (rather than rendering tool rows and the live
 * assistant as separate buckets) so that text emitted before a tool call
 * appears above the tool row instead of below it. Tool entries defer
 * finalization until the stream itself finalizes — promoting them earlier
 * would let a fast tool jump ahead of still-streaming assistant text in
 * `<Static>` scrollback, where insertion order is fixed. The complement (the
 * settled prefix) is {@link orderedStaticTranscriptEntries}.
 */
export function pendingTranscriptEntries(
  entries: readonly TranscriptRow[],
  settledRows: number,
  status: StreamPhase | undefined,
): TranscriptRow[] {
  const showLiveAssistant = isActivePhase(status);
  const pending: TranscriptRow[] = [];
  for (const [index, entry] of entries.entries()) {
    if (!isRenderableTranscriptEntry(entry)) continue;
    if (userPromptAwaitsLiveContinuation(entries, index, status)) {
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

const EMPTY_TRANSCRIPT_ENTRIES: readonly TranscriptRow[] = Object.freeze([]);

/** Cursor over the settled prefix of a stream's projected entries. The static
 *  transcript appends only entries after this cursor on ordinary syncs; a
 *  cursor mismatch (fold rebuild, owner switch, hard reset) forces a full
 *  rebuild through {@link orderedStaticTranscriptEntries}. */
export interface StaticTranscriptScanCursor {
  /** The `slice.entries` array the cursor was advanced against. */
  readonly entriesRef: readonly TranscriptRow[] | undefined;
  /** Number of leading entries already consumed by a previous scan. */
  readonly scannedIndex: number;
  /** Reference to `entriesRef[scannedIndex - 1]`, used to detect append-only
   *  extensions without rescanning the whole history. */
  readonly lastScannedEntry: TranscriptRow | undefined;
  /** Stream phase at scan time; a phase change forces a rescan of the tail. */
  readonly status: StreamPhase | undefined;
  /** Order key of the last row this cursor's scans appended to scrollback.
   *  A later suffix that sorts before it cannot be appended in place. */
  readonly lastAppendedKey: readonly [number, number] | undefined;
}

interface StaticTranscriptScanResult {
  readonly appended: readonly TranscriptRow[];
  readonly cursor: StaticTranscriptScanCursor;
  /** True when the caller must rebuild from scratch instead of using the
   *  returned suffix (owner switch, hard reset, or non-append-only change). */
  readonly rebuild: boolean;
}

function makeStaticTranscriptScanCursor(
  entriesRef: readonly TranscriptRow[] | undefined,
  scannedIndex: number,
  status: StreamPhase | undefined,
  lastAppendedKey: readonly [number, number] | undefined,
): StaticTranscriptScanCursor {
  return {
    entriesRef,
    scannedIndex,
    lastScannedEntry:
      entriesRef !== undefined && scannedIndex > 0
        ? entriesRef[scannedIndex - 1]
        : undefined,
    status,
    lastAppendedKey,
  };
}

/**
 * The settled-prefix scan used by the live static transcript. Unlike
 * {@link orderedStaticTranscriptEntries} (the full rebuild path), this walks
 * only the suffix after `previous.scannedIndex`, so ordinary stream-sync ticks
 * cost O(delta) instead of O(history).
 */
export function incrementalStaticTranscriptEntries(
  entries: readonly TranscriptRow[] | undefined,
  settledRows: number,
  status: StreamPhase | undefined,
  previous: StaticTranscriptScanCursor | undefined,
): StaticTranscriptScanResult {
  const source = entries ?? EMPTY_TRANSCRIPT_ENTRIES;
  // Every path that cannot trust the previous cursor (no cursor, a
  // non-append-only change, or a suffix that sorts before what an earlier tick
  // already printed) restarts the scan from the top and asks the caller to
  // rebuild through the oracle.
  function restartScan(): StaticTranscriptScanResult {
    return {
      appended: [],
      cursor: makeStaticTranscriptScanCursor(source, 0, status, undefined),
      rebuild: true,
    };
  }
  if (previous === undefined) {
    return restartScan();
  }

  const sameEntries = previous.entriesRef === source;
  if (
    sameEntries &&
    previous.status === status &&
    previous.scannedIndex >= source.length
  ) {
    return { appended: [], cursor: previous, rebuild: false };
  }

  const canContinue =
    sameEntries ||
    (source.length >= previous.scannedIndex &&
      (previous.scannedIndex === 0 ||
        source[previous.scannedIndex - 1] === previous.lastScannedEntry));
  if (!canContinue) {
    return restartScan();
  }

  const start = previous.scannedIndex;
  const suffix = source.slice(start);

  const appended: Array<{
    entry: TranscriptRow;
    index: number;
    key: readonly [number, number];
  }> = [];
  let scannedIndex = start;
  for (let index = 0; index < suffix.length; index += 1) {
    const entry = suffix[index]!;
    if (!isFinalizedTranscriptRow(start + index, settledRows)) {
      break;
    }
    if (!isRenderableTranscriptEntry(entry)) {
      scannedIndex = start + index + 1;
      continue;
    }
    if (userPromptAwaitsLiveContinuation(suffix, index, status)) {
      break;
    }
    scannedIndex = start + index + 1;
    appended.push({
      entry,
      index: start + index,
      key: transcriptOrderKey(entry, start + index),
    });
  }
  // Print the suffix in the same settlement order the rebuild oracle uses
  // (`orderedStaticTranscriptEntries`): a row that settled while an earlier
  // tool was still running must not swap places across a repaint. Sorting
  // covers a reorder inside one tick; a suffix whose first row belongs before
  // rows an earlier tick already printed cannot be appended at all, so it
  // falls back to the oracle rebuild (a known-origin repaint).
  const ordered = inSettlementOrder(appended);

  const first = ordered[0];
  if (
    first !== undefined &&
    previous.lastAppendedKey !== undefined &&
    compareTranscriptOrderKeys(first.key, previous.lastAppendedKey) < 0
  ) {
    return restartScan();
  }

  return {
    appended: ordered.map(({ entry }) => entry),
    cursor: makeStaticTranscriptScanCursor(
      source,
      scannedIndex,
      status,
      ordered.at(-1)?.key ?? previous.lastAppendedKey,
    ),
    rebuild: false,
  };
}
