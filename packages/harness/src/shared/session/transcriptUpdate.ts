/**
 * The one transcript reducer: session events straight to a run's
 * `TranscriptView` (rows, stages, compaction blocks) and the run model's
 * inputs. The session view's updater runs it for every subscribed run, and
 * `buildRunTranscript` runs the same reducer over one aggregate's committed
 * rows where no view holds the run, so live and cold reads cannot drift.
 *
 * The caller supplies each event's clock and id, and the reducer owns no
 * clock, timer, IO, or durable write. Each event type writes the value the
 * event means: a stage its stage and heading, a tool card its row from
 * one decode, a stream its text row, a `log` row its decoded payload
 * (`transcriptLogRows.ts`). The working state lives in `transcriptState.ts`.
 */
import { Predicate } from 'effect';
import {
  MESSAGE_TYPES,
  TOOL_CALL_STATUS,
  isPlainAgentIdentity,
  isTranscriptEvent,
  type SessionRow,
  type Stage,
  type ToolUseLog,
  type TraceRowFields,
} from '@shared/schemas';
import {
  applyCompactionActivityEvent,
  settleCompactionActivities,
} from '@shared/runs/compactionActivityProjection';
import { decodeToolUseLog } from '@shared/toolUse';

import {
  recordLogRow,
  recordProcessOutputRow,
  STREAMING_TEXT_ROW_KIND,
} from './transcriptLogRows';
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
import { standingAfter, type RunStanding } from './runRowReads';
import type { TranscriptView } from './sessionView';

/** A stage start opens its stage whole; a stage end closes the group
 *  its start opened and writes nothing for a group no start opened. A
 *  group's parent is a group this transcript opened, or it has none. */
function applyStage(
  d: Draft,
  event: Extract<TraceRowFields, { type: 'stage.start' | 'stage.end' }>,
): void {
  const at = d.ix.stageIndex.get(event.id);
  let group: Stage;
  if (event.type === 'stage.start') {
    group = {
      id: event.id,
      name: event.label,
      startTime: d.at,
      outcome: null,
      ...(event.parentId && d.ix.stageIndex.has(event.parentId)
        ? { parentStageId: event.parentId }
        : {}),
      ...(event.kind != null ? { kind: event.kind } : {}),
    };
  } else {
    if (at === undefined) return;
    group = {
      ...d.next.stages[at],
      outcome: event.status,
      endTime: d.at,
    };
  }
  const groups = writableArray(d, d.next, 'stages');
  if (at !== undefined) groups[at] = group;
  else d.ix.stageIndex.set(event.id, groups.push(group) - 1);
  d.touched = true;
}

// A card is a monotone machine: it opens once, takes progress while it is
// open, and closes once. A second start reopens a running card (a re-run
// attempt) and is a no-op on a closed one; progress after the close and a
// close without an open are dropped. Under the one publisher those rows cannot
// arrive out of order, so nothing here compensates for a race; the shape is
// the card's definition.
function record(d: Draft, event: TraceRowFields): void {
  const { ix } = d;
  switch (event.type) {
    case 'log':
      recordLogRow(d, event);
      return;
    case 'process.output':
      recordProcessOutputRow(d, event);
      return;

    case 'stage.start': {
      // A new model-turn boundary starts fresh: whatever MODEL_RESPONSE
      // stream the previous turn may have opened is no longer this turn's
      // to reuse. Tool-use turns are session stages containing several
      // inner model/tool rounds.
      if (event.kind === 'session') {
        ix.pendingModelResponseId = undefined;
      }
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
      });
      applyStage(d, event);
      return;
    }

    case 'stage.end': {
      const slot = ix.slots.get(event.id);
      if (slot?.kind === 'stage') write(d, slot);
      applyStage(d, event);
      return;
    }

    case 'tool.start': {
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
        ...(event.section !== undefined ? { section: event.section } : {}),
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
        base: open(
          d,
          event.logId,
          event.stageId,
          MESSAGE_TYPES.TOOL_USE,
          false,
        ),
        log,
        call,
      });
      ix.activeTools.add(event.logId);
      return;
    }

    case 'tool.end': {
      if (ix.closed) return;
      const slot = ix.slots.get(event.logId);
      if (slot?.kind !== 'tool') return;
      const inProgress = event.status === TOOL_CALL_STATUS.IN_PROGRESS;
      if (inProgress && !ix.activeTools.has(event.logId)) return;
      // On a run with a run history, the card's output is projected from its
      // `tool.result` and names no tool, input or card: those are the ones
      // its `tool.start` opened.
      const result: Record<PropertyKey, unknown> = Predicate.isObject(
        event.result,
      )
        ? event.result
        : {};
      slot.log = decodeToolUseLog({
        toolName: slot.log.toolName,
        input: slot.log.input,
        ...(slot.log.card ? { card: slot.log.card } : {}),
        ...result,
        status: event.status,
      });
      // The call's own end replaces a cut by the run's end.
      const { cutByRunEnd: _cut, ...call } = slot.call;
      slot.call = call;
      if (!inProgress) {
        slot.base = settle(ix, slot.base);
        ix.activeTools.delete(event.logId);
      }
      write(d, slot);
      return;
    }

    // Run facts, not transcript rows: they go to `RunView.context` and
    // `RunView.usage`.
    case 'context.state':
    case 'usage':
      return;

    case 'stream.start': {
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
      return;
    }

    case 'stream.end': {
      const slot = ix.slots.get(event.id);
      if (!ix.streams.has(event.id) || ix.closed || slot?.kind !== 'text') {
        return;
      }
      closeText(d, slot, event.finalText);
      ix.streams.delete(event.id);
      return;
    }

    case 'response.finalized': {
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
        if (slot?.kind === 'text') {
          if (event.cut !== undefined) slot.cut = event.cut;
          closeText(d, slot, event.text);
        }
        return;
      }
      write(d, {
        kind: 'text',
        base: open(
          d,
          d.stampId,
          event.stageId,
          MESSAGE_TYPES.MODEL_RESPONSE,
          true,
        ),
        rowKind: 'assistant',
        text: event.text,
        running: false,
        ...(event.cut === undefined ? {} : { cut: event.cut }),
      });
      return;
    }
    default:
      event satisfies never;
  }
}

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

/** Where a lifecycle row leaves its run ({@link standingAfter}) moves the
 *  transcript boundary: a waiting or ended run closes every open stream,
 *  fails every open card as cut by the run's end (`ToolRow.cutByRunEnd`)
 *  and finishes every open compaction as interrupted; an ended one also
 *  closes every open stage on its outcome, as the drain that ends a
 *  run no driver holds does. */
function applyStandingToTranscript(d: Draft, standing: RunStanding): void {
  const { ix } = d;
  if (standing.position === 'running') {
    ix.closed = false;
    return;
  }
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
    slot.log = { ...slot.log, status: TOOL_CALL_STATUS.FAILED };
    slot.call = { ...slot.call, cutByRunEnd: true };
    write(d, slot);
  }
  ix.activeTools.clear();
  const compactions = settleCompactionActivities(ix.compactionState, d.at);
  if (compactions.length > 0) {
    upsertCompactionRows(d, d.next, compactions);
    d.touched = true;
  }
  const { outcome } = standing;
  if (outcome === null || !d.next.stages.some(isOpenGroup)) return;
  d.next.stages = d.next.stages.map((group) =>
    isOpenGroup(group) ? { ...group, outcome, endTime: d.at } : group,
  );
  d.touched = true;
}

const isOpenGroup = (group: Stage): boolean => group.outcome === null;

/**
 * Apply one session event to a run's transcript, advancing the run's working
 * state in `work`. Returns the same value when the event changed nothing the
 * transcript holds.
 */
export function applyTranscriptEvent(
  transcript: TranscriptView,
  work: TranscriptWork,
  event: SessionRow,
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
  if (event.type === 'run.position' && event.payload.at === 'waiting')
    d.ix.lastWait = event.seq;
  const standing = standingAfter(event);
  if (standing !== null) applyStandingToTranscript(d, standing);
  else if (isTranscriptEvent(event)) {
    record(d, event);
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
  events: readonly SessionRow[],
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
    lifecycleStages: isPlainAgentIdentity(start.identity),
  };
  for (const event of events) {
    transcript = applyTranscriptEvent(transcript, work, event, ctx);
  }
  return transcript;
}
