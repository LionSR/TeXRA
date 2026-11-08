/**
 * The one transcript reducer: session events straight to a run's
 * `TranscriptView` (rows, stages, compaction blocks) and the run model's
 * inputs. The session view's updater runs it for every subscribed run, and
 * `buildRunTranscript` runs the same reducer over one aggregate's committed
 * rows where no view holds the run, so live and cold reads cannot drift.
 *
 * The caller supplies each event's clock and id, and the reducer owns no
 * clock, timer, IO, or durable write. Each event type writes the value the
 * event means: a plugin's stage its entry in `stages`, a tool card its row
 * from one decode (and the stage of a script card the cards under it name), a stream its text row, a `log` row its decoded payload
 * (`transcriptLogRows.ts`). The working state lives in `transcriptState.ts`.
 */
import { Predicate } from 'effect';
import {
  MESSAGE_TYPES,
  RUN_OUTCOME,
  TOOL_CALL_STATUS,
  isTranscriptEvent,
  type SessionRow,
  type Stage,
  type ToolCallStatus,
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

/** A plugin's section: its start opens the stage whole; its end closes the
 *  stage its start opened and writes nothing for one no start opened. */
function applyStage(
  d: Draft,
  event: Extract<TraceRowFields, { type: 'stage.start' | 'stage.end' }>,
): void {
  const at = d.ix.stageIndex.get(event.id);
  let stage: Stage;
  if (event.type === 'stage.start') {
    stage = {
      id: event.id,
      name: event.label,
      seqNo: (d.ix.appended += 1),
      startTime: d.at,
      outcome: null,
    };
  } else {
    if (at === undefined) return;
    stage = {
      ...d.next.stages[at],
      outcome: event.status,
      endTime: d.at,
    };
  }
  const stages = writableArray(d, d.next, 'stages');
  if (at !== undefined) stages[at] = stage;
  else d.ix.stageIndex.set(event.id, stages.push(stage) - 1);
  d.touched = true;
}

/**
 * A script's stage, projected from cards: a card starting under another card
 * (`stageId`, the `script` card that issued it) opens that card's stage,
 * labelled by its title, or reopens it when the run's end closed it and a
 * resume starts a call again; the script card's own close closes it on its
 * result.
 */
function openCardStage(d: Draft, card: string): void {
  const heading = d.ix.slots.get(card);
  if (heading?.kind !== 'tool') return;
  const at = d.ix.stageIndex.get(card);
  const stages = writableArray(d, d.next, 'stages');
  if (at === undefined) {
    const input = Predicate.isObject(heading.log.input)
      ? heading.log.input
      : {};
    const name =
      typeof input.title === 'string' && input.title.length > 0
        ? input.title
        : 'Script';
    const stage: Stage = {
      id: card,
      name,
      seqNo: (d.ix.appended += 1),
      startTime: d.at,
      outcome: null,
    };
    d.ix.stageIndex.set(card, stages.push(stage) - 1);
  } else if (stages[at].outcome !== null) {
    // Its time restarts with the resume, so its duration is time it ran.
    const { endTime: _end, ...open } = stages[at];
    stages[at] = { ...open, startTime: d.at, outcome: null };
  } else return;
  d.touched = true;
}

function closeCardStage(d: Draft, card: string, status: ToolCallStatus): void {
  const at = d.ix.stageIndex.get(card);
  if (at === undefined) return;
  const stages = writableArray(d, d.next, 'stages');
  stages[at] = {
    ...stages[at],
    outcome:
      status === TOOL_CALL_STATUS.COMPLETED
        ? RUN_OUTCOME.COMPLETED
        : RUN_OUTCOME.FAILED,
    endTime: d.at,
  };
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

    case 'stage.start':
    case 'stage.end':
      applyStage(d, event);
      return;

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
      // A card starting under a stage (a new call, or a resumed call's
      // retry under the same card) opens it, or reopens it after the run's
      // end closed it.
      if (event.stageId !== undefined) openCardStage(d, event.stageId);
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
        closeCardStage(d, event.logId, event.status);
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
  if (outcome === null || !d.next.stages.some(isOpenStage)) return;
  d.next.stages = d.next.stages.map((stage) =>
    isOpenStage(stage) ? { ...stage, outcome, endTime: d.at } : stage,
  );
  d.touched = true;
}

const isOpenStage = (stage: Stage): boolean => stage.outcome === null;

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
  // A turn starts fresh, and so does an activation (a resume may pick up a
  // turn mid-way): whatever MODEL_RESPONSE stream came before is no longer
  // this turn's for `response.finalized` to close.
  if (
    event.type === 'run.activate' ||
    (event.type === 'run.position' && event.payload.at === 'turn.begin')
  )
    d.ix.pendingModelResponseId = undefined;
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
  const ctx: TranscriptContext = { debug };
  for (const event of events) {
    transcript = applyTranscriptEvent(transcript, work, event, ctx);
  }
  return transcript;
}
