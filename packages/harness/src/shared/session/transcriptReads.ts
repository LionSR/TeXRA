/**
 * Reads and live inputs over a run's transcript working state: live text
 * chunks, finishing open compactions, and the activity flags.
 */
import { type TextChunk } from '@shared/schemas';
import { finalizeCompactionActivities } from '@shared/runs/compactionActivityProjection';
import type { RunLabels } from '@shared/tools/executionsDisplay';

import {
  rowById,
  slotRow,
  takesLiveText,
  upsertCompactionRows,
  upsertRow,
  type TranscriptIndexes,
  type TranscriptDraft,
  type TranscriptWork,
} from './transcriptState';
import type { TranscriptView } from './sessionView';

// ---------------------------------------------------------------------------
// Live text
// ---------------------------------------------------------------------------

/** What a live chunk did: nothing, moved the held text without a row to
 *  paint, or repainted a row into `transcript`. */
type LiveTextOutcome =
  | { readonly outcome: 'ignored' }
  | { readonly outcome: 'held' }
  | { readonly outcome: 'repainted'; readonly transcript: TranscriptView };

const IGNORED: LiveTextOutcome = Object.freeze({ outcome: 'ignored' });
const HELD: LiveTextOutcome = Object.freeze({ outcome: 'held' });

/**
 * Apply one live chunk: ignored when its `to` is not past the text held,
 * otherwise the held text is truncated at `from` and the chunk appended, so a
 * redelivery in any order is a no-op and a `from: 0` chunk replaces the row.
 * The row is painted anew from its slot and the text held, as its own event
 * paints it. Durable text wins: a row whose finalizing event has been
 * applied takes no chunk (`takesLiveText`).
 */
export function applyLiveText(
  transcript: TranscriptView,
  work: TranscriptWork,
  chunk: TextChunk,
  runLabels: RunLabels,
): LiveTextOutcome {
  const { ix } = work;
  const slot = ix.slots.get(chunk.rowId);
  if (slot !== undefined && !takesLiveText(slot)) return IGNORED;
  const held = ix.live.get(chunk.rowId) ?? '';
  if (chunk.to <= held.length) return IGNORED;
  if (chunk.from > held.length) {
    throw new Error(
      `text chunk for ${chunk.runId}/${chunk.rowId} starts at ${chunk.from}, past the ${held.length} characters held`,
    );
  }
  const text = held.slice(0, chunk.from) + chunk.text;
  ix.live.set(chunk.rowId, text);
  // A chunk ahead of its row: the row paints when its event is applied,
  // joined with this text. A stream whose text is still blank paints none.
  const row =
    slot && slotRow(slot, text, { runLabels, interrupted: work.interrupted });
  if (row === undefined) return HELD;
  const next: TranscriptDraft = { ...transcript };
  upsertRow(work, next, row);
  return { outcome: 'repainted', transcript: next };
}

/** Drop the live text held for a run's rows: the run ended. */
export function clearLiveText(ix: TranscriptIndexes): void {
  ix.live.clear();
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Paint the cards still open again, as `work.interrupted` now reads them:
 * the run's holder went away, or a resume took the run up again. A waiting
 * or ended run has no open card, its rows having closed them all.
 */
export function repaintOpenCards(
  transcript: TranscriptView,
  work: TranscriptWork,
  runLabels: RunLabels,
): TranscriptView {
  const { ix } = work;
  let next: TranscriptDraft | undefined;
  for (const slot of ix.slots.values()) {
    if (slot.kind !== 'tool' || !takesLiveText(slot)) continue;
    const row = slotRow(slot, ix.live.get(slot.base.id), {
      runLabels,
      interrupted: work.interrupted,
    });
    if (row === undefined) continue;
    next ??= { ...transcript };
    upsertRow(work, next, row);
  }
  return next ?? transcript;
}

/** Finish the compactions still open when the turn ends. */
export function finishOpenCompactions(
  transcript: TranscriptView,
  work: TranscriptWork,
  finishedAt: number,
): TranscriptView {
  const changed = finalizeCompactionActivities(
    work.ix.compactionState,
    finishedAt,
  );
  if (changed.length === 0) return transcript;
  const next: TranscriptDraft = { ...transcript };
  upsertCompactionRows(work, next, changed);
  return next;
}

/** Whether the newest thinking row is streaming and a compaction runs. */
export function transcriptActivity(
  transcript: TranscriptView,
  ix: TranscriptIndexes,
): {
  thinkingActive: boolean;
  compactingActive: boolean;
} {
  const { thinkingRowId, compactionState } = ix;
  const lastThinking =
    thinkingRowId === undefined
      ? undefined
      : rowById(transcript, ix, thinkingRowId);
  return {
    thinkingActive: lastThinking?.kind === 'thinking' && lastThinking.streaming,
    compactingActive: compactionState.blocks.some(
      (block) => block.status === 'running',
    ),
  };
}
