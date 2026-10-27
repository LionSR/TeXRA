/**
 * The one transcript reducer: session events straight to a run's
 * `TranscriptView` (rows, task groups, compaction blocks) and the run model's
 * inputs. The session view's updater runs it for every subscribed run, and
 * `buildRunTranscript` runs the same reducer over one aggregate's committed
 * rows where no view holds the run, so live and cold reads cannot drift.
 *
 * The caller supplies each event's clock and id, and the reducer owns no
 * clock, timer, IO, or durable write. Each event type writes the value the
 * event means: a stage its task group and heading, a tool card its row from
 * one decode, a stream its text row, a `log` row its decoded payload
 * (`transcriptLogRows.ts`). The working state lives in `transcriptState.ts`.
 */
import { Predicate } from 'effect';
import {
  MESSAGE_TYPES,
  RUN_PHASE,
  TOOL_CALL_STATUS,
  isPlainAgentIdentity,
  isTranscriptEvent,
  type RunPhase,
  type SessionEvent,
  type TaskGroup,
  type ToolUseLog,
  type TranscriptEvent,
} from '@shared/schemas';
import { applyCompactionActivityEvent } from '@shared/runs/compactionActivityProjection';
import { isTerminalOutcomePhase } from '@shared/runs/runStatus';
import { decodeToolUseLog } from '@shared/toolUse';
import { TOOL_CUT_BY_RUN_END } from '@shared/transcript/scriptStage';

import { recordLogRow, STREAMING_TEXT_ROW_KIND } from './transcriptLogRows';
import {
  emptyTranscript,
  emptyTranscriptIndexes,
  open,
  paint,
  settle,
  upsertCompactionRows,
  writableArray,
  write,
  type Draft,
  type Slot,
  type TranscriptContext,
  type TranscriptWork,
} from './transcriptState';
import { phaseMoveOf } from './runRows';
import type { TranscriptView } from './sessionView';

/** A stage start opens its task group whole; a stage end closes the group
 *  its start opened and writes nothing for a group no start opened. */
function applyTaskGroup(
  d: Draft,
  event: Extract<TranscriptEvent, { type: 'stage.start' | 'stage.end' }>,
): void {
  const at = d.ix.taskGroupIndex.get(event.id);
  let group: TaskGroup;
  if (event.type === 'stage.start') {
    group = {
      id: event.id,
      name: event.label,
      startTime: d.at,
      status: RUN_PHASE.RUNNING,
      ...(event.parentId ? { parentGroupId: event.parentId } : {}),
      ...(event.kind != null ? { kind: event.kind } : {}),
    };
  } else {
    if (at === undefined) return;
    group = {
      ...d.next.taskGroups[at],
      status: event.status,
      endTime: d.at,
    };
  }
  const groups = writableArray(d, d.next.taskGroups);
  d.next.taskGroups = groups;
  if (at !== undefined) groups[at] = group;
  else d.ix.taskGroupIndex.set(event.id, groups.push(group) - 1);
  d.touched = true;
}

/** The transcript event of type `K`. */
type EventOf<K extends TranscriptEvent['type']> = Extract<
  TranscriptEvent,
  { type: K }
>;
/** How one transcript event type changes the draft. */
type Recorder<K extends TranscriptEvent['type']> = (
  d: Draft,
  event: EventOf<K>,
) => void;

/** A stage's heading row and its task group. */
function openStage(d: Draft, event: EventOf<'stage.start'>): void {
  // A new model-turn boundary starts fresh: whatever MODEL_RESPONSE
  // stream the previous turn may have opened is no longer this turn's
  // to reuse. Tool-use turns are session stages containing several
  // inner model/tool rounds.
  if (event.kind === 'session') d.ix.pendingModelResponseId = undefined;
  write(d, {
    kind: 'stage',
    base: open(
      d,
      event.id,
      event.parentId ?? undefined,
      MESSAGE_TYPES.DEFAULT,
      true,
    ),
    label: event.label,
    open: true,
  });
  applyTaskGroup(d, event);
}

function closeStage(d: Draft, event: EventOf<'stage.end'>): void {
  const slot = d.ix.slots.get(event.id);
  if (slot?.kind === 'stage') {
    slot.open = false;
    write(d, slot);
  }
  applyTaskGroup(d, event);
}

// A card is a monotone machine: it opens once, takes progress while it is
// open, and closes once. A second start reopens a running card (a re-run
// attempt) and is a no-op on a closed one; progress after the close and a
// close without an open are dropped. Under the one publisher those rows cannot
// arrive out of order, so nothing here compensates for a race; the shape is
// the card's definition.
function openToolCard(d: Draft, event: EventOf<'tool.start'>): void {
  const { ix } = d;
  if (ix.closed) return;
  ix.pendingModelResponseId = undefined;
  // event.logId is the canonical id: SDK consumers correlate
  // tool.start/end by it, and the row shares it.
  const log = {
    toolName: event.toolName,
    input: event.input,
    ...(event.card ? { card: event.card } : {}),
    status: TOOL_CALL_STATUS.IN_PROGRESS,
  } satisfies ToolUseLog;
  const call = {
    ...(event.phase !== undefined ? { phase: event.phase } : {}),
    ...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
  };
  const slot = ix.slots.get(event.logId);
  if (slot) {
    if (slot.kind === 'tool' && ix.activeTools.has(event.logId)) {
      slot.log = log;
      slot.call = call;
      write(d, slot);
    }
    return;
  }
  write(d, {
    kind: 'tool',
    base: open(d, event.logId, event.stageId, MESSAGE_TYPES.TOOL_USE, false),
    log,
    call,
  });
  ix.activeTools.add(event.logId);
}

function closeToolCard(d: Draft, event: EventOf<'tool.end'>): void {
  const { ix } = d;
  if (ix.closed) return;
  const slot = ix.slots.get(event.logId);
  if (slot?.kind !== 'tool') return;
  const inProgress = event.status === TOOL_CALL_STATUS.IN_PROGRESS;
  if (inProgress && !ix.activeTools.has(event.logId)) return;
  // On a run with a run history, the card's output is projected from its
  // `tool.result` and names no tool, input or card: those are the ones
  // its `tool.start` opened.
  const result: Record<PropertyKey, unknown> = Predicate.isObject(event.result)
    ? event.result
    : {};
  slot.log = decodeToolUseLog({
    toolName: slot.log.toolName,
    input: slot.log.input,
    ...(slot.log.card ? { card: slot.log.card } : {}),
    ...result,
    status: event.status,
  });
  if (!inProgress) {
    slot.base = settle(ix, slot.base);
    ix.activeTools.delete(event.logId);
  }
  write(d, slot);
}

function openStream(d: Draft, event: EventOf<'stream.start'>): void {
  const { ix } = d;
  if (ix.closed) return;
  const messageType = event.kind;
  ix.streams.add(event.id);
  if (messageType === MESSAGE_TYPES.MODEL_RESPONSE) {
    ix.pendingModelResponseId = event.id;
  }
  write(d, {
    kind: 'text',
    base: open(d, event.id, event.stageId, messageType, false),
    rowKind: STREAMING_TEXT_ROW_KIND[messageType],
    text: '',
    running: true,
  });
}

function closeStream(d: Draft, event: EventOf<'stream.end'>): void {
  const { ix } = d;
  const slot = ix.slots.get(event.id);
  if (!ix.streams.has(event.id) || ix.closed || slot?.kind !== 'text') return;
  closeText(d, slot, event.finalText);
  ix.streams.delete(event.id);
}

function finalizeResponse(
  d: Draft,
  event: EventOf<'response.finalized'>,
): void {
  const { ix } = d;
  if (ix.closed || !event.text) return;
  // Upsert by id, not by text: if this round's own MODEL_RESPONSE stream
  // already wrote a (possibly raw, pre-replacement) row, replace its text
  // with the final one and close the stream, so no later stream.end or
  // run boundary can replace that text; otherwise this round
  // never streamed (e.g. a non-streaming provider call), so append it.
  const correlatorId = ix.pendingModelResponseId;
  ix.pendingModelResponseId = undefined;
  if (correlatorId) {
    ix.streams.delete(correlatorId);
    const slot = ix.slots.get(correlatorId);
    if (slot?.kind === 'text') closeText(d, slot, event.text);
    return;
  }
  write(d, {
    kind: 'text',
    base: open(d, d.stampId, event.stageId, MESSAGE_TYPES.MODEL_RESPONSE, true),
    rowKind: 'assistant',
    text: event.text,
    running: false,
  });
}

/** One recorder per transcript event type: a type left out fails to
 *  compile. */
const RECORDERS: { readonly [K in TranscriptEvent['type']]: Recorder<K> } = {
  log: recordLogRow,
  'stage.start': openStage,
  'stage.end': closeStage,
  'tool.start': openToolCard,
  'tool.end': closeToolCard,
  // Run facts, not transcript rows: they go to `RunView.context` and
  // `RunView.usage`.
  'context.state': () => undefined,
  usage: () => undefined,
  'stream.start': openStream,
  'stream.end': closeStream,
  'response.finalized': finalizeResponse,
};

/** The recorder for `type`. */
const recorderOf = <K extends TranscriptEvent['type']>(type: K): Recorder<K> =>
  RECORDERS[type];

/** Close a text row, now printable, with its final text when one is given. */
function closeText(
  d: Draft,
  slot: Extract<Slot, { kind: 'text' }>,
  finalText: string | undefined,
): void {
  slot.base = settle(d.ix, slot.base);
  if (finalText !== undefined) slot.text = finalText;
  slot.running = false;
  write(d, slot);
}

/** A phase move ({@link phaseMoveOf}) moves the transcript boundary: a
 *  waiting or ended run closes every open stream and fails every open card. */
function moveBoundary(d: Draft, phase: RunPhase): void {
  const { ix } = d;
  if (phase === RUN_PHASE.RUNNING) {
    ix.closed = false;
    return;
  }
  if (phase !== RUN_PHASE.WAITING && !isTerminalOutcomePhase(phase)) return;
  ix.closed = true;
  ix.pendingModelResponseId = undefined;
  for (const id of ix.streams) {
    const slot = ix.slots.get(id);
    if (slot?.kind === 'text') closeText(d, slot, undefined);
  }
  ix.streams.clear();
  for (const id of ix.activeTools) {
    const slot = ix.slots.get(id);
    if (slot?.kind !== 'tool') continue;
    slot.base = settle(ix, slot.base);
    slot.log = {
      ...slot.log,
      status: TOOL_CALL_STATUS.FAILED,
      error: TOOL_CUT_BY_RUN_END,
    };
    write(d, slot);
  }
  ix.activeTools.clear();
}

/**
 * Apply one session event to a run's transcript, advancing the run's working
 * state in `work`. Returns the same value when the event changed nothing the
 * transcript holds.
 */
export function applyTranscriptEvent(
  transcript: TranscriptView,
  work: TranscriptWork,
  event: SessionEvent,
  ctx: TranscriptContext,
): TranscriptView {
  const d: Draft = {
    ...work,
    next: { ...transcript },
    ctx,
    at: event.at,
    stampId: JSON.stringify([event.aggregateId, event.seq]),
    written: [],
    touched: false,
  };
  if (
    event.type === 'run.position' &&
    (event.payload.at === 'waiting' || event.payload.at === 'halted')
  )
    d.ix.lastWait = event.seq;
  const phase = phaseMoveOf(event);
  if (phase !== null) moveBoundary(d, phase);
  else if (isTranscriptEvent(event)) {
    recorderOf(event.type)(d, event);
    // A transcript event writes at most one slot; its position is the row's
    // first appearance (a tool's first-seen one), so a tool that started
    // before a compaction and ended after it never interrupts it.
    const position = d.written[0]?.base.seqNo;
    if (position !== undefined) {
      const changed = applyCompactionActivityEvent(
        d.ix.compactionState,
        event,
        position,
        event.at,
      );
      if (changed.length > 0) {
        upsertCompactionRows(d, d.next, changed);
        d.touched = true;
      }
    }
  }
  for (const slot of d.written) paint(d, slot);
  return d.touched ? d.next : transcript;
}

/**
 * One aggregate's transcript, built cold from its committed rows by the same
 * reducer the session view runs: where no view holds the run (export, a
 * waiting run's closure, host exit). Empty when the run has no rows.
 * `settledRows` stays 0: only the session view advances that prefix, so a
 * cold read uses `rows` and `openWork`, never `settledRows`.
 */
export function buildRunTranscript(
  events: readonly SessionEvent[],
  debug: boolean,
): TranscriptView {
  const work: TranscriptWork = {
    ix: emptyTranscriptIndexes(),
    owned: new WeakSet(),
  };
  let transcript = emptyTranscript();
  const start = events[0];
  if (start === undefined) return transcript;
  if (start.type !== 'run.start' || start.seq !== 1) {
    throw new Error('A transcript read must begin with its creation row.');
  }
  const ctx: TranscriptContext = {
    debug,
    lifecycleToTaskGroups: isPlainAgentIdentity(start.identity),
  };
  for (const event of events) {
    transcript = applyTranscriptEvent(transcript, work, event, ctx);
  }
  return transcript;
}
