/**
 * Reads and live inputs over a run's transcript working state: live text
 * chunks, compaction settlement, the activity flags, the run model's inputs,
 * and what the run left open.
 */
import {
  isTerminalWorkflowCallProgress,
  type TaskGroup,
  type TextChunk,
  type WorkflowCallLiveProgress,
  type WorkflowDeclaredPlan,
} from '@shared/schemas';
import { settleCompactionActivities } from '@shared/runs/compactionActivityProjection';
import { hasIncompleteEmbeddedSubagentFollowup } from '@shared/subagentFollowup';
import type { RunLabels } from '@shared/tools/executionsDisplay';
import {
  streamingTextRow,
  toolRow,
  transcriptText,
  type TranscriptRow,
  type TranscriptRowKind,
} from '@ui/transcript';
import { appendTranscriptText } from '@ui/transcript/transcriptText';

import {
  indexesOf,
  isStreamingTextRow,
  replaceTranscript,
  rowById,
  upsertCompactionRows,
  upsertRow,
  writableArray,
} from './transcriptState';
import type { TranscriptView } from './sessionView';

// ---------------------------------------------------------------------------
// Live text
// ---------------------------------------------------------------------------

/**
 * Apply one live chunk (PRD 5.2, "Live text"): ignored when its `to` is not
 * past the text held, otherwise the held text is truncated at `from` and the
 * chunk appended, so a redelivery in any order is a no-op and a `from: 0`
 * chunk replaces the row. An append costs the chunk, never the row; the
 * embedded-followup flag is the one whole-text scan, and it runs only while a
 * block is open or the chunk could open one. Durable text wins: a row whose
 * finalizing event has folded is never reopened. Returns null when the chunk
 * changed nothing, the same value when it only moved the held text of a row
 * not yet folded, and a new value when a row repainted.
 */
export function foldLiveText(
  transcript: TranscriptView,
  chunk: TextChunk,
  runLabels: RunLabels,
): TranscriptView | null {
  const ix = indexesOf(transcript);
  const cursor = ix.cursors.get(chunk.rowId);
  if (!cursor && rowById(transcript, chunk.rowId)) return null;
  const held = ix.live.get(chunk.rowId) ?? '';
  if (chunk.to <= held.length) return null;
  if (chunk.from > held.length) {
    throw new Error(
      `text chunk for ${chunk.runId}/${chunk.rowId} starts at ${chunk.from}, past the ${held.length} characters held`,
    );
  }
  const text = held.slice(0, chunk.from) + chunk.text;
  ix.live.set(chunk.rowId, text);
  // The row paints when its event folds, joined with this text.
  if (!cursor) return transcript;
  const slot = ix.slots.get(chunk.rowId);
  const next = replaceTranscript(transcript, {});
  if (slot?.kind === 'tool') {
    upsertRow(next, toolRow(slot.base, slot.log, text, runLabels));
    return next;
  }
  const measured =
    chunk.from === held.length
      ? appendTranscriptText(cursor, chunk.text, held.at(-1) ?? '')
      : transcriptText(text);
  ix.cursors.set(chunk.rowId, measured);
  const at = ix.rowIndex.get(chunk.rowId);
  const row = at === undefined ? undefined : next.rows[at];
  if (at !== undefined && row && isStreamingTextRow(row)) {
    const { pendingEmbeddedFollowup: wasPending, ...rest } = row;
    const pending =
      row.kind === 'assistant' && (wasPending || chunk.text.includes('<'))
        ? hasIncompleteEmbeddedSubagentFollowup(measured.full)
        : wasPending;
    writableArray(next, 'rows')[at] = {
      ...rest,
      text: measured,
      ...(pending ? { pendingEmbeddedFollowup: true } : {}),
    };
  } else if (slot?.kind === 'text' && slot.rowKind) {
    // The row's own text was blank and painted no row; the chunk that gives
    // it one paints it once.
    const painted = streamingTextRow(
      slot.base,
      slot.rowKind,
      measured.full,
      slot.running,
    );
    if (painted) upsertRow(next, painted);
  }
  return next;
}

/** Drop a run's live text and its streaming cursors: the run ended, was
 *  removed, or lost its transcript tier (PRD 5.2, "In-flight text"). */
export function clearLiveText(transcript: TranscriptView): void {
  const ix = indexesOf(transcript);
  ix.live.clear();
  ix.cursors.clear();
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Finalize unmatched compaction starts when the turn settles. */
export function settleTranscript(
  transcript: TranscriptView,
  finishedAt: number,
): TranscriptView {
  const changed = settleCompactionActivities(
    indexesOf(transcript).compactionState,
    finishedAt,
  );
  if (changed.length === 0) return transcript;
  const next = replaceTranscript(transcript, {});
  upsertCompactionRows(next, changed);
  return next;
}

/** Whether the newest thinking row is streaming and a compaction runs. */
export function transcriptActivity(transcript: TranscriptView): {
  thinkingActive: boolean;
  compactingActive: boolean;
} {
  const { thinkingRowId, compactionState } = indexesOf(transcript);
  const lastThinking =
    thinkingRowId === undefined
      ? undefined
      : rowById(transcript, thinkingRowId);
  return {
    thinkingActive: lastThinking?.kind === 'thinking' && lastThinking.streaming,
    compactingActive: compactionState.blocks.some(
      (block) => block.status === 'running',
    ),
  };
}

/** Canonical dashboard rows a workflow-script run model reads. */
const WORKFLOW_DASHBOARD_KINDS = new Set<TranscriptRowKind>([
  'compactionActivity',
  'phase',
  'workflowTask',
]);

/** Residency cap on one run model's dashboard rows (PRD 5.2). */
const MAX_RUN_MODEL_DASHBOARD_ROWS = 2_000;

/**
 * The run model's inputs (PRD 5.2, section 4 of the build note): the newest
 * dashboard rows up to the cap, the phase groups those rows still name (a
 * phase whose every card fell off the cap is not shown), and the newest plan.
 */
export function runModelInputs(transcript: TranscriptView): {
  rows: TranscriptRow[];
  taskGroups: TaskGroup[];
  plan: WorkflowDeclaredPlan | undefined;
  workflowAttemptId: string | undefined;
} {
  const { plan, workflowAttemptId } = indexesOf(transcript);
  const dashboard = transcript.rows.filter((row) =>
    WORKFLOW_DASHBOARD_KINDS.has(row.kind),
  );
  const rows =
    dashboard.length > MAX_RUN_MODEL_DASHBOARD_ROWS
      ? dashboard.slice(-MAX_RUN_MODEL_DASHBOARD_ROWS)
      : dashboard;
  if (rows.length === dashboard.length) {
    return { rows, taskGroups: transcript.taskGroups, plan, workflowAttemptId };
  }
  const retainedPhaseIds = new Set<string>();
  for (const row of rows) {
    if (row.kind === 'phase') retainedPhaseIds.add(row.id);
    else if (row.groupId !== undefined) retainedPhaseIds.add(row.groupId);
  }
  return {
    rows,
    taskGroups: transcript.taskGroups.filter(
      (group) => group.kind !== 'phase' || retainedPhaseIds.has(group.id),
    ),
    plan,
    workflowAttemptId,
  };
}

/** What a run left open, in first-appearance order: what closes it when its
 *  host exits or it parks. */
export type OpenWork =
  | { readonly kind: 'stage'; readonly id: string }
  | { readonly kind: 'stream'; readonly id: string; readonly text: string }
  | {
      readonly kind: 'call';
      readonly id: string;
      readonly stageId: string | undefined;
      readonly call: WorkflowCallLiveProgress;
    };

export function openWork(transcript: TranscriptView): OpenWork[] {
  const open: { readonly seqNo: number; readonly work: OpenWork }[] = [];
  for (const slot of indexesOf(transcript).slots.values()) {
    const seqNo = slot.base.seqNo ?? 0;
    const { id } = slot.base;
    if (slot.kind === 'stage' && slot.open) {
      open.push({ seqNo, work: { kind: 'stage', id } });
    } else if (slot.kind === 'text' && slot.running && slot.rowKind) {
      open.push({ seqNo, work: { kind: 'stream', id, text: slot.text } });
    } else if (
      slot.kind === 'call' &&
      !isTerminalWorkflowCallProgress(slot.call)
    ) {
      open.push({
        seqNo,
        work: { kind: 'call', id, stageId: slot.base.groupId, call: slot.call },
      });
    }
  }
  return open.sort((a, b) => a.seqNo - b.seqNo).map(({ work }) => work);
}
