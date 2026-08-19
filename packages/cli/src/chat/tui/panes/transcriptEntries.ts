import stripAnsi from 'strip-ansi';

import { ANSI_ESCAPE_START, ansiEscapeEnd } from '@cli/runtime/ansiEscapes';
import { type StreamPhase } from '@shared/schemas';
import { isActivePhase } from '@shared/streams/streamStatus';

import type { ConversationEntry } from '../state/cliState';

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

export function terminalVisibleTranscriptText(text: string): string {
  let out = '';
  for (const char of stripAnsi(text)) {
    if (!isInvisibleTranscriptChar(char)) out += char;
  }
  return out;
}

export function isInquiryContinuationText(text: string): boolean {
  return INQUIRY_CONTINUATION_RE.test(text);
}

export function trimAssistantTranscriptLead(text: string): string {
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

export function isRenderableTranscriptEntry(entry: ConversationEntry): boolean {
  switch (entry.role) {
    case 'activity':
    case 'assistant':
    case 'error':
    case 'user':
    case 'phase':
    case 'workflowTask':
      return terminalVisibleTranscriptText(entry.text).trim().length > 0;
    // An attachment load and a compact detail row are rows because the
    // projector said so; the terminal never re-decides membership. A file list
    // whose entries all failed to load is exactly the case a reader must see.
    case 'detail':
    case 'media':
    case 'tool':
      return true;
  }
}

/** Callers gate on {@link isRenderableTranscriptEntry} before asking. */
function userPromptAwaitsLiveContinuation(
  entries: readonly ConversationEntry[],
  index: number,
  status: StreamPhase | undefined,
): boolean {
  const entry = entries[index];
  if (
    entry?.role !== 'user' ||
    isInquiryContinuationText(entry.text) ||
    !isActivePhase(status)
  ) {
    return false;
  }
  return !entries.some(
    (later, laterIndex) =>
      laterIndex > index && isRenderableTranscriptEntry(later),
  );
}

/** Whether an entry belongs in append-only terminal scrollback now. */
function isStaticTranscriptEntryAt(
  entries: readonly ConversationEntry[],
  index: number,
  status: StreamPhase | undefined,
): boolean {
  const entry = entries[index];
  return (
    entry !== undefined &&
    entry.finalized &&
    isRenderableTranscriptEntry(entry) &&
    !userPromptAwaitsLiveContinuation(entries, index, status)
  );
}

/** `(settlement order, synthetic-after-source tiebreak)` sort key for one entry. */
function transcriptOrderKey(
  entry: ConversationEntry,
  index: number,
): readonly [seq: number, synthetic: number] {
  const seq =
    entry.settlementSeqNo ??
    entry.syntheticAfterSettlementSeqNo ??
    entry.sourceSeqNo ??
    index + 1;
  const synthetic = entry.syntheticAfterSettlementSeqNo !== undefined ? 1 : 0;
  return [seq, synthetic];
}

function compareTranscriptOrderKeys(
  left: readonly [number, number],
  right: readonly [number, number],
): number {
  return left[0] - right[0] || left[1] - right[1];
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
  entries: readonly ConversationEntry[],
  status: StreamPhase | undefined,
): readonly ConversationEntry[] {
  const candidates: Array<{
    entry: ConversationEntry;
    index: number;
    key: readonly [number, number];
  }> = [];
  for (const [index, entry] of entries.entries()) {
    if (!entry.finalized) break;
    if (!isStaticTranscriptEntryAt(entries, index, status)) continue;
    candidates.push({ entry, index, key: transcriptOrderKey(entry, index) });
  }

  const alreadyOrdered = candidates.every(
    (candidate, i) =>
      i === 0 ||
      compareTranscriptOrderKeys(candidates[i - 1]!.key, candidate.key) <= 0,
  );
  const ordered = alreadyOrdered
    ? candidates
    : candidates.toSorted(
        (left, right) =>
          compareTranscriptOrderKeys(left.key, right.key) ||
          left.index - right.index,
      );

  return ordered.map(({ entry }) => entry);
}

export function splitTranscriptEntries(
  entries: readonly ConversationEntry[],
  status: StreamPhase | undefined,
): {
  readonly finalized: ConversationEntry[];
  /** Non-finalized entries in original stream order. The renderer must
   *  walk this list (rather than rendering tool rows and the live
   *  assistant as separate buckets) so that text emitted before a tool
   *  call appears above the tool row instead of below it. Tool entries
   *  defer finalization until the stream itself finalizes — promoting
   *  them earlier would let a fast tool jump ahead of still-streaming
   *  assistant text in `<Static>` scrollback, where insertion order is
   *  fixed. */
  readonly pending: ConversationEntry[];
} {
  const showLiveAssistant = isActivePhase(status);
  const finalized: ConversationEntry[] = [];
  const pending: ConversationEntry[] = [];
  let canPromoteToStatic = true;
  for (const [index, entry] of entries.entries()) {
    // Mirror the static-ring settled-prefix barrier: any unfinished entry
    // blocks later finalized rows from static promotion, so they stay visible
    // in the live pending pane instead of disappearing between the two panes.
    if (!entry.finalized) {
      canPromoteToStatic = false;
    }
    if (!isRenderableTranscriptEntry(entry)) continue;
    if (userPromptAwaitsLiveContinuation(entries, index, status)) {
      pending.push(entry);
      continue;
    }
    if (entry.finalized) {
      (canPromoteToStatic ? finalized : pending).push(entry);
      continue;
    }
    if (
      entry.role === 'activity' ||
      entry.role === 'tool' ||
      entry.role === 'workflowTask'
    ) {
      pending.push(entry);
      continue;
    }
    if (entry.role === 'assistant' && showLiveAssistant) {
      pending.push(entry);
    }
  }
  return { finalized, pending };
}

const EMPTY_TRANSCRIPT_ENTRIES: readonly ConversationEntry[] = Object.freeze(
  [],
);

/** Cursor over the settled prefix of a stream's projected entries. The static
 *  transcript appends only entries after this cursor on ordinary syncs; a
 *  cursor mismatch (fold rebuild, owner switch, hard reset) forces a full
 *  rebuild through {@link orderedStaticTranscriptEntries}. */
export interface StaticTranscriptScanCursor {
  /** The `slice.entries` array the cursor was advanced against. */
  readonly entriesRef: readonly ConversationEntry[] | undefined;
  /** Number of leading entries already consumed by a previous scan. */
  readonly scannedIndex: number;
  /** Reference to `entriesRef[scannedIndex - 1]`, used to detect append-only
   *  extensions without rescanning the whole history. */
  readonly lastScannedEntry: ConversationEntry | undefined;
  /** Stream phase at scan time; a phase change forces a rescan of the tail. */
  readonly status: StreamPhase | undefined;
}

export interface StaticTranscriptScanResult {
  readonly appended: readonly ConversationEntry[];
  readonly cursor: StaticTranscriptScanCursor;
  /** True when the caller must rebuild from scratch instead of using the
   *  returned suffix (owner switch, hard reset, or non-append-only change). */
  readonly rebuild: boolean;
}

function makeStaticTranscriptScanCursor(
  entriesRef: readonly ConversationEntry[] | undefined,
  scannedIndex: number,
  status: StreamPhase | undefined,
): StaticTranscriptScanCursor {
  return {
    entriesRef,
    scannedIndex,
    lastScannedEntry:
      entriesRef !== undefined && scannedIndex > 0
        ? entriesRef[scannedIndex - 1]
        : undefined,
    status,
  };
}

/**
 * The settled-prefix scan used by the live static transcript. Unlike
 * {@link orderedStaticTranscriptEntries} (the full rebuild path), this walks
 * only the suffix after `previous.scannedIndex`, so ordinary stream-sync ticks
 * cost O(delta) instead of O(history).
 *
 * The suffix is exact: `hasLaterRenderable` is computed backward over just
 * the suffix, which is all that is needed to resolve the live-user-prompt
 * deferral rule (`userPromptAwaitsLiveContinuation`).
 */
export function incrementalStaticTranscriptEntries(
  entries: readonly ConversationEntry[] | undefined,
  status: StreamPhase | undefined,
  previous: StaticTranscriptScanCursor | undefined,
): StaticTranscriptScanResult {
  const source = entries ?? EMPTY_TRANSCRIPT_ENTRIES;
  if (previous === undefined) {
    return {
      appended: [],
      cursor: makeStaticTranscriptScanCursor(source, 0, status),
      rebuild: true,
    };
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
    return {
      appended: [],
      cursor: makeStaticTranscriptScanCursor(source, 0, status),
      rebuild: true,
    };
  }

  const start = previous.scannedIndex;
  const suffix = source.slice(start);
  const hasLaterRenderable = new Array<boolean>(suffix.length);
  let laterRenderable = false;
  for (let index = suffix.length - 1; index >= 0; index -= 1) {
    hasLaterRenderable[index] = laterRenderable;
    const entry = suffix[index]!;
    if (isRenderableTranscriptEntry(entry)) {
      laterRenderable = true;
    }
  }

  const appended: ConversationEntry[] = [];
  let scannedIndex = start;
  for (let index = 0; index < suffix.length; index += 1) {
    const entry = suffix[index]!;
    if (!entry.finalized) break;
    if (!isRenderableTranscriptEntry(entry)) {
      scannedIndex = start + index + 1;
      continue;
    }
    const defersLiveUserPrompt =
      isActivePhase(status) &&
      entry.role === 'user' &&
      !isInquiryContinuationText(entry.text) &&
      !hasLaterRenderable[index];
    if (defersLiveUserPrompt) break;
    scannedIndex = start + index + 1;
    appended.push(entry);
  }

  return {
    appended,
    cursor: makeStaticTranscriptScanCursor(source, scannedIndex, status),
    rebuild: false,
  };
}
