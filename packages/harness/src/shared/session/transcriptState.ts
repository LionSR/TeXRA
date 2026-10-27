/**
 * A run's transcript working state: what each written id left behind, the
 * row and group positions, the open cards and streams, and the live text.
 * Its owner keeps it beside the `TranscriptView` it builds, never on it (the
 * session view's updater keeps one per run, a cold read its own), so a host
 * can neither depend on nor mutate it. `transcriptUpdate.ts` writes it one
 * event at a time; `paint` turns a written slot into the row every host
 * renders.
 */
import {
  TOOL_CALL_STATUS,
  type LogLevel,
  type MessageType,
  type ToolUseLog,
} from '@shared/schemas';
import {
  createCompactionActivityProjection,
  type CompactionActivityProjection,
} from '@shared/runs/compactionActivityProjection';
import { compareBySeqNo } from '@shared/runs/runOrdering';
import type { RunLabels } from '@shared/tools/executionsDisplay';
import {
  transcriptText,
  type TranscriptText,
} from '@shared/transcript/transcriptText';
import {
  compactionActivityRow,
  type StreamingTextRow,
  type ToolCallFacts,
  type TranscriptRow,
  type TranscriptRowBase,
} from '@shared/transcript/transcriptRow';
import {
  logPayloadRow,
  plainLogRow,
  streamingTextRow,
  toolRow,
  type LogRowPayload,
} from '@shared/transcript/projectTranscriptRow';

import type { TranscriptView } from './sessionView';

/** What a run's transcript is built under. */
export interface TranscriptContext {
  /** The surface shows debug-level log rows. */
  readonly debug: boolean;
  /** Run and session headings go to the task-group surface rather than the
   *  rows: a plain agent run's (`isPlainAgentIdentity`). A full-log child,
   *  a detached process or an external-CLI session keeps its verbatim log. */
  readonly lifecycleToTaskGroups: boolean;
  /** The session's runs by id, for the `executions` tool header. */
  readonly runLabels?: RunLabels;
}

// ---------------------------------------------------------------------------
// Working state (never on the view)
// ---------------------------------------------------------------------------

/** The current state of one row id (a stage, a text stream, a tool card or a
 *  log row): what a later event for the same id updates, and what `paint`
 *  turns into the row. */
export type Slot =
  | {
      readonly kind: 'stage';
      base: TranscriptRowBase;
      readonly label: string;
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
  | {
      readonly kind: 'tool';
      base: TranscriptRowBase;
      log: ToolUseLog;
      /** What the card's `tool.start` says of a script's call. */
      call: ToolCallFacts;
    }
  | {
      readonly kind: 'log';
      readonly base: TranscriptRowBase;
      readonly text: string;
      readonly payload: LogRowPayload;
      /** A user message's fork point (`UserRow.forkAt`). */
      readonly forkAt?: number;
    };

/** A run's transcript working state: the positions, slots, open cards and
 *  streams, and live text one event at a time reads and writes. */
export interface TranscriptIndexes {
  /** Row position by row id; an entry is never removed. */
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
  /** The run is waiting or ended: cards and streams stay closed until it
   *  runs again. */
  closed: boolean;
  /** Live text per row id, beside the rows rather than inside them: a chunk
   *  can arrive before its row. A row paints its durable text joined with
   *  this entry; the entry goes when the row finalizes or the run ends, and
   *  with the whole state when the run is removed or unsubscribed. */
  readonly live: Map<string, string>;
  /** Measured live text per streaming row id, extended per chunk rather than
   *  re-measured; a running tool card's is empty. */
  readonly cursors: Map<string, TranscriptText>;
  /** The newest thinking row, for `thinkingActive`. */
  thinkingRowId: string | undefined;
  /** The `seq` of the run's newest wait (a `run.position` at `waiting` or
   *  `halted`): the point a user message that follows forks at. */
  lastWait: number | null;
  /** A user message has been taken: a wait before the first one (a fork's
   *  seed) cuts before nothing. */
  seenUserMessage: boolean;
}

/** A fresh run's working state. */
export function emptyTranscriptIndexes(): TranscriptIndexes {
  return {
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
    lastWait: null,
    seenUserMessage: false,
  };
}

/** A transcript with no rows. */
export function emptyTranscript(): TranscriptView {
  return { rows: [], taskGroups: [], settledRows: 0 };
}

/** A transcript one update call is building: a fresh envelope over the
 *  previous transcript's arrays, written field by field until published. */
export type TranscriptDraft = {
  -readonly [K in keyof TranscriptView]: TranscriptView[K];
};

// ---------------------------------------------------------------------------
// Copy on first write
// ---------------------------------------------------------------------------

/**
 * A run's working state, and the arrays the current update call created:
 * those are written in place. Any other array belongs to a transcript already
 * returned, so it is copied on its first write; one call copies each array at
 * most once, however many events it applies.
 */
export interface TranscriptWork {
  readonly ix: TranscriptIndexes;
  readonly owned: WeakSet<object>;
}

/** Whether `array` is one of this call's own copies (`writableArray`). */
const isOwnedCopy = <T>(
  work: TranscriptWork,
  array: readonly T[],
): array is T[] => work.owned.has(array);

/** `array` if this call created it, else a copy this call owns, which the
 *  caller stores back on its draft. */
export function writableArray<T>(
  work: TranscriptWork,
  array: readonly T[],
): T[] {
  if (isOwnedCopy(work, array)) return array;
  const copy = [...array];
  work.owned.add(copy);
  return copy;
}

/** The one writer of `rows`: in place by id, else inserted in `seqNo` order. */
export function upsertRow(
  work: TranscriptWork,
  transcript: TranscriptDraft,
  row: TranscriptRow,
): void {
  const rows = writableArray(work, transcript.rows);
  transcript.rows = rows;
  const { rowIndex } = work.ix;
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

/** Paint the compaction blocks at `changedIndices` as their rows. */
export function upsertCompactionRows(
  work: TranscriptWork,
  transcript: TranscriptDraft,
  changedIndices: readonly number[],
): void {
  for (const blockIndex of changedIndices) {
    const block = work.ix.compactionState.blocks[blockIndex];
    if (block) upsertRow(work, transcript, compactionActivityRow(block));
  }
}

type StreamingTextRowOf = Extract<
  TranscriptRow,
  { kind: StreamingTextRow['kind'] }
>;

/** Whether `row`'s text streams: an assistant reply, thinking or scratchpad. */
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
export interface Draft extends TranscriptWork {
  readonly next: TranscriptDraft;
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
): TranscriptRowBase {
  d.ix.appended += 1;
  return {
    id,
    seqNo: d.ix.appended,
    timestamp: d.at,
    level,
    verbose: d.ctx.debug,
    messageType,
    ...(settled ? { settlementSeqNo: (d.ix.settled += 1) } : {}),
    ...(groupId !== undefined ? { groupId } : {}),
  };
}

/** The envelope once the row became printable; settles once. */
export function settle(
  ix: TranscriptIndexes,
  base: TranscriptRowBase,
): TranscriptRowBase {
  return base.settlementSeqNo === undefined
    ? { ...base, settlementSeqNo: (ix.settled += 1) }
    : base;
}

/** Record `slot` as its id's state; it paints once the event is applied. */
export function write(d: Draft, slot: Slot): void {
  d.ix.slots.set(slot.base.id, slot);
  d.written.push(slot);
  d.touched = true;
}

function rowOf(
  slot: Slot,
  live: string | undefined,
  ctx: TranscriptContext,
): TranscriptRow | undefined {
  switch (slot.kind) {
    case 'stage':
      return ctx.lifecycleToTaskGroups
        ? undefined
        : plainLogRow(slot.base, slot.label);
    case 'text': {
      const text = live ?? slot.text;
      return slot.rowKind
        ? streamingTextRow(slot.base, slot.rowKind, text, slot.running)
        : plainLogRow(slot.base, text);
    }
    case 'tool':
      return toolRow(slot.base, slot.log, live, ctx.runLabels, slot.call);
    case 'log':
      return logPayloadRow(slot.base, slot.text, slot.payload, slot.forkAt);
  }
}

/** The live text a written slot holds: a stream's, a running card's, none. */
function liveStateOf(slot: Slot): 'stream' | 'card' | 'final' {
  if (slot.kind === 'text' && slot.running && slot.rowKind !== undefined)
    return 'stream';
  if (slot.kind === 'tool' && slot.log.status === TOOL_CALL_STATUS.IN_PROGRESS)
    return 'card';
  return 'final';
}

/** Row `id` at `at` is the newest thinking row unless a later row is. */
function noteThinkingRow(ix: TranscriptIndexes, id: string, at: number): void {
  const newest =
    ix.thinkingRowId === undefined
      ? undefined
      : ix.rowIndex.get(ix.thinkingRowId);
  if (newest === undefined || newest <= at) ix.thinkingRowId = id;
}

/**
 * Paint one written slot. A streaming row joins its durable fields with its
 * live text, which may have arrived first; a finalizing row drops that text,
 * so a late chunk cannot reopen it.
 */
export function paint(d: Draft, slot: Slot): void {
  const { ix, next } = d;
  const id = slot.base.id;
  const state = liveStateOf(slot);
  // One holder of a row's live text, `live`, whichever arrives first: chunks
  // extend it, and a row applied before any chunk seeds it with the text it
  // carried, so the chunk re-delivering that text from offset zero ends
  // within the length held and is dropped.
  if (
    state === 'stream' &&
    slot.kind === 'text' &&
    slot.text &&
    !ix.live.has(id)
  )
    ix.live.set(id, slot.text);
  const live = state === 'final' ? undefined : ix.live.get(id);
  const row = rowOf(slot, live, d.ctx);
  if (row) upsertRow(d, next, row);
  const at = ix.rowIndex.get(id);
  const current = at === undefined ? undefined : next.rows[at];
  if (at !== undefined && current?.kind === 'thinking')
    noteThinkingRow(ix, id, at);
  switch (state) {
    case 'stream':
      ix.cursors.set(
        id,
        current && isStreamingTextRow(current)
          ? current.text
          : transcriptText(live ?? ''),
      );
      return;
    case 'card':
      // A card's output paints from the held text, never a measured cursor.
      ix.cursors.set(id, transcriptText(''));
      return;
    case 'final':
      ix.cursors.delete(id);
      ix.live.delete(id);
  }
}
