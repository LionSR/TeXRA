/**
 * The transcript fold's working state (PRD one-fold-three-renderers, 5.2):
 * what each written id left behind, the row and group positions, the open
 * cards and streams, and the live text, kept beside each `TranscriptView`
 * value in a module-private map so a host can neither depend on nor mutate
 * it. `transcriptFold.ts` writes it one event at a time; `paint` turns a
 * written slot into the row every host renders.
 */
import {
  AgentCategory,
  TOOL_CALL_STATUS,
  isPlainAgentIdentity,
  type LogLevel,
  type MessageType,
  type ToolUseLog,
  type WorkflowCallProgress,
  type WorkflowDeclaredPlan,
} from '@shared/schemas';
import {
  createCompactionActivityProjection,
  type CompactionActivityProjection,
} from '@shared/runs/compactionActivityProjection';
import { compareBySeqNo } from '@shared/runs/runOrdering';
import type { RunLabels } from '@shared/tools/executionsDisplay';
import {
  compactionActivityRow,
  logPayloadRow,
  phaseRow,
  plainLogRow,
  streamingTextRow,
  toolRow,
  workflowTaskRow,
  type LogRowPayload,
  type StreamingTextRow,
  type TranscriptRow,
  type TranscriptRowBase,
  transcriptText,
  type TranscriptText,
} from '@ui/transcript';

import type { RunView, TranscriptView } from './sessionView';

/** What a run's transcript is folded under. */
export interface TranscriptContext {
  /** The surface shows debug-level log rows. */
  readonly debug: boolean;
  /** Run, round, and session headings go to the task-group surface rather
   *  than the rows (`lifecycleToTaskGroups`). */
  readonly lifecycleToTaskGroups: boolean;
  /** The session's runs by id, for the `executions` tool header. */
  readonly runLabels?: RunLabels;
}

/**
 * Whether a run's run, round, and session headings go to the task-group
 * surface rather than the rows (keyed on the identity, never the id format):
 * every workflow run and every plain agent run. The one exception is a
 * full-log child that is not a workflow run, a detached process or an
 * external-CLI session, whose verbatim log is the point of opening it. Phase
 * headers are unaffected: they stay rows everywhere.
 */
export function lifecycleToTaskGroups(
  run: Pick<RunView, 'category' | 'identity'>,
): boolean {
  return (
    run.category === AgentCategory.Workflow ||
    isPlainAgentIdentity(run.identity)
  );
}

// ---------------------------------------------------------------------------
// Working state (fold-owned, never on the view)
// ---------------------------------------------------------------------------

/** What an id's writes left behind: what the events that write it again,
 *  its live text, and the open-work questions read. */
export type Slot =
  | {
      readonly kind: 'stage';
      base: TranscriptRowBase;
      readonly label: string;
      /** Present on a workflow phase, whose heading is always a row. */
      readonly phase?: { readonly index?: number; readonly total?: number };
      open: boolean;
    }
  | {
      readonly kind: 'text';
      base: TranscriptRowBase;
      /** Undefined for a stream of a kind with no streaming row. */
      readonly rowKind: StreamingTextRow['kind'] | undefined;
      /** The durable text; live text is held apart (`live`). */
      text: string;
      running: boolean;
    }
  | { readonly kind: 'tool'; base: TranscriptRowBase; log: ToolUseLog }
  | {
      readonly kind: 'call';
      base: TranscriptRowBase;
      call: WorkflowCallProgress;
    }
  | {
      readonly kind: 'log';
      readonly base: TranscriptRowBase;
      readonly text: string;
      readonly payload: LogRowPayload;
    };

export interface TranscriptIndexes {
  /** Row position by row id. */
  readonly rowIndex: Map<string, number>;
  /** Task-group position by group id. */
  readonly taskGroupIndex: Map<string, number>;
  /** The compaction projection's working state. */
  readonly compactionState: CompactionActivityProjection;
  readonly slots: Map<string, Slot>;
  /** Slots opened so far and slots settled so far: the last `seqNo` (first
   *  appearance) and `settlementSeqNo` (became printable) handed out. */
  appended: number;
  settled: number;
  /** Streams `stream.start` opened that nothing has settled yet. */
  readonly streams: Set<string>;
  /** Tool cards `tool.start` opened that are still in progress. */
  readonly activeTools: Set<string>;
  /** This turn's model-response stream, which `response.finalized` closes. */
  pendingModelResponseId: string | undefined;
  /** The run parked or ended: cards and streams stay closed until it runs. */
  closed: boolean;
  /** Live text per row id, beside the rows rather than inside them: a chunk
   *  can reach the fold before its row (PRD 5.2). A row paints its durable
   *  text joined with this entry; the entry goes when the row finalizes, the
   *  run ends, the run is removed, or its transcript tier is evicted. */
  readonly live: Map<string, string>;
  /** Measured live text per streaming row id, extended per chunk rather than
   *  re-measured; a running tool card's is empty. */
  readonly cursors: Map<string, TranscriptText>;
  /** The newest thinking row, for `thinkingActive`. */
  thinkingRowId: string | undefined;
  /** The newest `workflow.plan`, for the run model. */
  plan: WorkflowDeclaredPlan | undefined;
  workflowAttemptId: string | undefined;
}

const INDEXES = new WeakMap<TranscriptView, TranscriptIndexes>();

export function indexesOf(transcript: TranscriptView): TranscriptIndexes {
  const indexes = INDEXES.get(transcript);
  if (!indexes) {
    throw new Error('TranscriptView value was not created by the fold');
  }
  return indexes;
}

/** A replaced transcript value sharing the previous value's indexes. */
export function replaceTranscript(
  transcript: TranscriptView,
  patch: Partial<TranscriptView>,
): TranscriptView {
  const next: TranscriptView = { ...transcript, ...patch };
  INDEXES.set(next, indexesOf(transcript));
  return next;
}

export function emptyTranscript(): TranscriptView {
  const transcript: TranscriptView = {
    rows: [],
    taskGroups: [],
    settledRows: 0,
    run: null,
  };
  INDEXES.set(transcript, {
    rowIndex: new Map(),
    taskGroupIndex: new Map(),
    compactionState: createCompactionActivityProjection(),
    slots: new Map(),
    appended: 0,
    settled: 0,
    streams: new Set(),
    activeTools: new Set(),
    pendingModelResponseId: undefined,
    closed: false,
    live: new Map(),
    cursors: new Map(),
    thinkingRowId: undefined,
    plan: undefined,
    workflowAttemptId: undefined,
  });
  return transcript;
}

// ---------------------------------------------------------------------------
// Copy on touch (D5)
// ---------------------------------------------------------------------------

/**
 * The row and group arrays this level created: written directly. Any other
 * array belongs to a published level and is copied on its first write. Reset
 * at the start of every level (`resetTranscriptOwnership`), so a throw
 * mid-fold cannot carry ownership into the next call.
 */
let owned = new WeakSet<object>();

/** Start a new publication level: nothing built before it is written. */
export function resetTranscriptOwnership(): void {
  owned = new WeakSet();
}

export function writableArray<K extends 'rows' | 'taskGroups'>(
  transcript: TranscriptView,
  key: K,
): TranscriptView[K] {
  const current = transcript[key];
  if (owned.has(current)) return current;
  const copy = [...current] as TranscriptView[K];
  owned.add(copy);
  transcript[key] = copy;
  return copy;
}

export function rowById(
  transcript: TranscriptView,
  id: string,
): TranscriptRow | undefined {
  const at = indexesOf(transcript).rowIndex.get(id);
  return at === undefined ? undefined : transcript.rows[at];
}

/** The one writer of `rows`: in place by id, else inserted in `seqNo` order. */
export function upsertRow(
  transcript: TranscriptView,
  row: TranscriptRow,
): void {
  const rows = writableArray(transcript, 'rows');
  const { rowIndex } = indexesOf(transcript);
  const at = rowIndex.get(row.id);
  if (at !== undefined) {
    rows[at] = row;
    return;
  }
  const seqOf = (candidate: TranscriptRow) => candidate.seqNo;
  const timeOf = (candidate: TranscriptRow) => candidate.timestamp;
  let position = rows.length;
  while (
    position > 0 &&
    compareBySeqNo(rows[position - 1], row, seqOf, timeOf) > 0
  ) {
    position -= 1;
  }
  if (position === rows.length) {
    rowIndex.set(row.id, rows.length);
    rows.push(row);
    return;
  }
  rows.splice(position, 0, row);
  for (let i = position; i < rows.length; i += 1) rowIndex.set(rows[i].id, i);
}

export function upsertCompactionRows(
  transcript: TranscriptView,
  changedIndices: readonly number[],
): void {
  const { compactionState } = indexesOf(transcript);
  for (const blockIndex of changedIndices) {
    const block = compactionState.blocks[blockIndex];
    if (block) upsertRow(transcript, compactionActivityRow(block));
  }
}

type StreamingTextRowOf = Extract<
  TranscriptRow,
  { kind: StreamingTextRow['kind'] }
>;

export function isStreamingTextRow(
  row: TranscriptRow,
): row is StreamingTextRowOf {
  return (
    row.kind === 'assistant' ||
    row.kind === 'thinking' ||
    row.kind === 'scratchpad'
  );
}

// ---------------------------------------------------------------------------
// One event
// ---------------------------------------------------------------------------

/** One event's working copy: the next value and the slots it wrote. */
export interface Draft {
  readonly ix: TranscriptIndexes;
  readonly next: TranscriptView;
  readonly ctx: TranscriptContext;
  readonly at: number;
  /** The event's durable coordinates: the id of a row it appends. */
  readonly stampId: string;
  readonly written: Slot[];
  touched: boolean;
}

/** A new slot's envelope: the next first-appearance position, and the next
 *  settlement position when it is printable on arrival. */
export function open(
  d: Draft,
  id: string,
  groupId: string | undefined,
  messageType: MessageType,
  settled: boolean,
  level: LogLevel = 'info',
  verbose: boolean = d.ctx.debug,
): TranscriptRowBase {
  d.ix.appended += 1;
  return {
    id,
    seqNo: d.ix.appended,
    timestamp: d.at,
    level,
    verbose,
    messageType,
    ...(settled ? { settlementSeqNo: (d.ix.settled += 1) } : {}),
    ...(groupId !== undefined ? { groupId } : {}),
  };
}

/** The envelope once the row became printable; settles once. */
export function settle(ix: TranscriptIndexes, base: TranscriptRowBase) {
  return base.settlementSeqNo === undefined
    ? { ...base, settlementSeqNo: (ix.settled += 1) }
    : base;
}

export function write(d: Draft, slot: Slot): void {
  d.ix.slots.set(slot.base.id, slot);
  d.written.push(slot);
  d.touched = true;
}

function rowOf(
  slot: Slot,
  live: string | undefined,
  previous: TranscriptRow | undefined,
  ctx: TranscriptContext,
): TranscriptRow | undefined {
  switch (slot.kind) {
    case 'stage': {
      if (slot.phase) {
        // A reopened phase with no counts of its own keeps the ones the
        // earlier row established, so `(2/3)` does not vanish.
        const prior = previous?.kind === 'phase' ? previous : undefined;
        return phaseRow(
          slot.base,
          slot.label,
          slot.phase.index ?? prior?.phaseIndex,
          slot.phase.total ?? prior?.phaseTotal,
        );
      }
      return ctx.lifecycleToTaskGroups
        ? undefined
        : plainLogRow(slot.base, slot.label);
    }
    case 'text': {
      const text = live ?? slot.text;
      return slot.rowKind
        ? streamingTextRow(slot.base, slot.rowKind, text, slot.running)
        : plainLogRow(slot.base, text);
    }
    case 'tool':
      return toolRow(slot.base, slot.log, live, ctx.runLabels);
    case 'call':
      return workflowTaskRow(slot.base, slot.call);
    case 'log':
      return logPayloadRow(slot.base, slot.text, slot.payload);
  }
}

/**
 * Paint one written slot. A streaming row joins its durable fields with its
 * live text, which may have arrived first (PRD 5.2, "In-flight text"); a
 * finalizing row drops that text, so a late chunk cannot reopen it.
 */
export function paint(d: Draft, slot: Slot): void {
  const { ix, next } = d;
  const id = slot.base.id;
  const streamingText =
    slot.kind === 'text' && slot.running && slot.rowKind !== undefined;
  const runningTool =
    slot.kind === 'tool' && slot.log.status === TOOL_CALL_STATUS.IN_PROGRESS;
  // One holder of a row's live text, `live`, whichever arrives first: chunks
  // extend it, and a row that folds before any chunk seeds it with the text
  // it carried, so the chunk re-delivering that text from offset zero ends
  // within the length held and is dropped.
  if (streamingText && slot.text && !ix.live.has(id)) {
    ix.live.set(id, slot.text);
  }
  const live = streamingText || runningTool ? ix.live.get(id) : undefined;
  const row = rowOf(slot, live, rowById(next, id), d.ctx);
  if (row) upsertRow(next, row);
  const current = rowById(next, id);
  if (current?.kind === 'thinking') {
    const newest = ix.thinkingRowId;
    const at = ix.rowIndex.get(id)!;
    if (newest === undefined || ix.rowIndex.get(newest)! <= at) {
      ix.thinkingRowId = id;
    }
  }
  if (streamingText) {
    ix.cursors.set(
      id,
      current && isStreamingTextRow(current)
        ? current.text
        : transcriptText(live ?? ''),
    );
  } else if (runningTool) {
    // A card's output paints from the held text, never a measured cursor.
    ix.cursors.set(id, transcriptText(''));
  } else {
    ix.cursors.delete(id);
    ix.live.delete(id);
  }
}
