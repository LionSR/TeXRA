/**
 * Reads and live inputs over a run's transcript: live text chunks, finishing
 * open compactions, and the run facts its rows decide (`transcriptFacts`).
 */
import { MESSAGE_TYPES, type TextChunk } from '@shared/schemas';
import { settleCompactionActivities } from '@shared/runs/compactionActivityProjection';
import { hasIncompleteEmbeddedSubagentFollowup } from '@shared/subagentFollowup';
import type { RunLabels } from '@shared/tools/executionsDisplay';
import {
  transcriptText,
  appendTranscriptText,
  type TranscriptText,
} from '@shared/transcript/transcriptText';
import {
  isSettledRow,
  rowHeadline,
  type TranscriptRow,
} from '@shared/transcript/transcriptRow';
import {
  streamingTextRow,
  toolRow,
} from '@shared/transcript/projectTranscriptRow';

import {
  isStreamingTextRow,
  upsertCompactionRows,
  upsertRow,
  writableArray,
  type Slot,
  type TranscriptIndexes,
  type TranscriptDraft,
  type TranscriptWork,
} from './transcriptState';
import type { TranscriptView } from './sessionView';

// ---------------------------------------------------------------------------
// Live text
// ---------------------------------------------------------------------------

/**
 * Apply one live chunk: ignored when its `to` is not past the text held,
 * otherwise the held text is truncated at `from` and the chunk appended, so a
 * redelivery in any order is a no-op and a `from: 0` chunk replaces the row.
 * An append costs the chunk, never the row. Durable text wins: a row whose
 * finalizing event has been applied is never reopened. Returns null when the
 * chunk changed nothing, the same value when it only moved the held text of a
 * row not yet applied, and a new value when a row repainted.
 */
export function applyLiveText(
  transcript: TranscriptView,
  work: TranscriptWork,
  chunk: TextChunk,
  runLabels: RunLabels,
): TranscriptView | null {
  const { ix } = work;
  const cursor = ix.cursors.get(chunk.rowId);
  if (!cursor && rowById(transcript, ix, chunk.rowId)) return null;
  const held = ix.live.get(chunk.rowId) ?? '';
  if (chunk.to <= held.length) return null;
  if (chunk.from > held.length) {
    throw new Error(
      `text chunk for ${chunk.runId}/${chunk.rowId} starts at ${chunk.from}, past the ${held.length} characters held`,
    );
  }
  const text = held.slice(0, chunk.from) + chunk.text;
  ix.live.set(chunk.rowId, text);
  // The row paints when its event is applied, joined with this text.
  if (!cursor) return transcript;
  const slot = ix.slots.get(chunk.rowId);
  const next: TranscriptDraft = { ...transcript };
  if (slot?.kind === 'tool') {
    upsertRow(work, next, toolRow(slot.base, slot.log, text, runLabels));
    return next;
  }
  const measured =
    chunk.from === held.length
      ? appendTranscriptText(cursor, chunk.text, held.at(-1) ?? '')
      : transcriptText(text);
  ix.cursors.set(chunk.rowId, measured);
  repaintStreamingRow(work, next, chunk, slot, measured);
  return next;
}

/**
 * Repaint the chunk's streaming row with its measured text. The
 * embedded-followup flag is the one whole-text scan, and it runs only while a
 * block is open or the chunk could open one. A row whose own text was blank
 * painted no row; the chunk that gives it one paints it once.
 */
function repaintStreamingRow(
  work: TranscriptWork,
  next: TranscriptDraft,
  chunk: TextChunk,
  slot: Slot | undefined,
  measured: TranscriptText,
): void {
  const at = work.ix.rowIndex.get(chunk.rowId);
  const row = at === undefined ? undefined : next.rows[at];
  if (at !== undefined && row && isStreamingTextRow(row)) {
    const { pendingEmbeddedFollowup: wasPending, ...rest } = row;
    const pending =
      row.kind === 'assistant' && (wasPending || chunk.text.includes('<'))
        ? hasIncompleteEmbeddedSubagentFollowup(measured.full)
        : wasPending;
    const rows = writableArray(work, next.rows);
    next.rows = rows;
    rows[at] = {
      ...rest,
      text: measured,
      ...(pending ? { pendingEmbeddedFollowup: true } : {}),
    };
    return;
  }
  if (slot?.kind !== 'text' || !slot.rowKind) return;
  const painted = streamingTextRow(
    slot.base,
    slot.rowKind,
    measured.full,
    slot.running,
  );
  if (painted) upsertRow(work, next, painted);
}

/** Drop a run's live text and its streaming cursors: the run ended. */
export function clearLiveText(ix: TranscriptIndexes): void {
  ix.live.clear();
  ix.cursors.clear();
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The row `id` names in `transcript`, if it has painted one. */
function rowById(
  transcript: TranscriptView,
  ix: TranscriptIndexes,
  id: string,
): TranscriptRow | undefined {
  const at = ix.rowIndex.get(id);
  return at === undefined ? undefined : transcript.rows[at];
}

/** Finish the compactions still open when the turn ends. */
export function finishOpenCompactions(
  transcript: TranscriptView,
  work: TranscriptWork,
  finishedAt: number,
): TranscriptView {
  const changed = settleCompactionActivities(
    work.ix.compactionState,
    finishedAt,
  );
  if (changed.length === 0) return transcript;
  const next: TranscriptDraft = { ...transcript };
  upsertCompactionRows(work, next, changed);
  return next;
}

function nonEmpty(text: string | undefined): string | undefined {
  return text !== undefined && text.trim().length > 0 ? text : undefined;
}

/** A run's newest operational summary, for one with no reply to show (a
 *  script's run, a task's recipe): what its tool, card, error, or
 *  plain log row last said. */
function operationalLatestLine(
  rows: TranscriptView['rows'],
): string | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row.kind === 'tool') {
      const line =
        nonEmpty(row.toolUse.headerSummary) ?? nonEmpty(row.model.headerLabel);
      if (line) return line;
      continue;
    }
    if (
      row.kind === 'error' ||
      ((row.kind === 'assistant' || row.kind === 'log') &&
        row.messageType === MESSAGE_TYPES.DEFAULT)
    ) {
      const line = nonEmpty(rowHeadline(row));
      if (line) return line;
    }
  }
  return undefined;
}

/** Any other run's newest user instruction or settled model reply. */
function latestConversationLine(
  rows: TranscriptView['rows'],
  settledRows: number,
): string | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    const headline = rowHeadline(row);
    if (headline.trim().length === 0) continue;
    if (row.kind === 'user') return headline;
    const response =
      (row.kind === 'assistant' || row.kind === 'log') &&
      row.messageType === MESSAGE_TYPES.MODEL_RESPONSE;
    if (
      response &&
      (index < settledRows || isSettledRow(row, index < rows.length - 1))
    ) {
      return headline;
    }
  }
  return undefined;
}

/**
 * Advance `settledRows`, the contiguous leading prefix of settled rows: an
 * append-only scrollback prints rows in order, so a row is settled for
 * printing only once every row before it is. Only the tail past the previous
 * frontier is walked. A finished run settles every open row except a
 * compaction block, which cleanup can still replace.
 */
function advanceSettledRows(
  rows: TranscriptView['rows'],
  start: number,
  runFinal: boolean,
): number {
  let index = Math.min(start, rows.length);
  while (index < rows.length) {
    const row = rows[index];
    if (!isSettledRow(row, index < rows.length - 1)) {
      // Bridge cleanup can still replace a planned/running compaction after
      // a cancellation, so it settles only on its own typed terminal state,
      // never on the final stream status.
      if (row.kind === 'compactionActivity' || !runFinal) break;
    }
    index += 1;
  }
  return index;
}

/** The run facts its transcript decides, which the session view copies onto
 *  the run so no host reads them off the rows. */
interface TranscriptFacts {
  /** The contiguous leading prefix of settled rows (`advanceSettledRows`). */
  readonly settledRows: number;
  /** The newest thinking row is streaming. */
  readonly thinkingActive: boolean;
  /** A compaction is in progress. */
  readonly compactingActive: boolean;
  /** The newest user instruction or settled reply, else the newest
   *  operational summary; undefined when no row says either. */
  readonly latestLine: string | undefined;
}

/** The facts `transcript` decides about its run; `runFinal` when the run
 *  waits or has ended, which settles every open row but a compaction. */
export function transcriptFacts(
  transcript: TranscriptView,
  ix: TranscriptIndexes,
  runFinal: boolean,
): TranscriptFacts {
  const { rows } = transcript;
  const settledRows = advanceSettledRows(
    rows,
    transcript.settledRows,
    runFinal,
  );
  const { thinkingRowId, compactionState } = ix;
  const lastThinking =
    thinkingRowId === undefined
      ? undefined
      : rowById(transcript, ix, thinkingRowId);
  return {
    settledRows,
    thinkingActive: lastThinking?.kind === 'thinking' && lastThinking.streaming,
    compactingActive: compactionState.blocks.some(
      (block) => block.status === 'running',
    ),
    latestLine:
      latestConversationLine(rows, settledRows) ?? operationalLatestLine(rows),
  };
}
