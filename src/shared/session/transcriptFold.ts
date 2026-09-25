/**
 * The one transcript reducer: session events straight to a run's
 * `TranscriptView` (rows, task groups, compaction blocks) and the run model's
 * inputs. The session fold runs it for every resident run, and
 * `foldRunTranscript` runs the same reducer over one aggregate's committed
 * rows where no view is resident, so live and cold reads cannot drift.
 *
 * Pure: the caller supplies each event's clock and id, and the reducer owns no
 * clock, timer, IO, or durable write. Each arm writes the value the event
 * means: a stage its task group and heading, a tool card its row from one
 * decode, a stream its text row, a `log` row its decoded payload
 * (`transcriptLogRows.ts`). The working state lives in `transcriptState.ts`.
 */
import {
  MESSAGE_TYPES,
  RUN_PHASE,
  TOOL_CALL_STATUS,
  isTerminalWorkflowCallProgress,
  isTranscriptEvent,
  type LogLevel,
  type RunPhase,
  type SessionEvent,
  type TaskGroup,
  type ToolUseLog,
  type TranscriptEvent,
} from '@shared/schemas';
import { applyCompactionActivityEvent } from '@shared/runs/compactionActivityProjection';
import { isTerminalOutcomePhase } from '@shared/runs/runStatus';
import { taskGroupOnStage } from '@shared/runs/taskGroupProjection';
import { decodeToolUseLog } from '@shared/toolUse';
import { isObject } from '@utils/core';

import {
  asMessageType,
  recordLogRow,
  STREAMING_TEXT_ROW_KIND,
} from './transcriptLogRows';
import {
  emptyTranscript,
  indexesOf,
  lifecycleToTaskGroups,
  open,
  paint,
  replaceTranscript,
  resetTranscriptOwnership,
  settle,
  upsertCompactionRows,
  writableArray,
  write,
  type Draft,
  type Slot,
  type TranscriptContext,
} from './transcriptState';
import type { TranscriptView } from './sessionView';

function foldTaskGroup(
  d: Draft,
  event: Extract<TranscriptEvent, { type: 'stage.start' | 'stage.end' }>,
): void {
  const at = d.ix.taskGroupIndex.get(event.id);
  const group: TaskGroup | undefined = taskGroupOnStage(
    at === undefined ? undefined : d.next.taskGroups[at],
    event,
    d.at,
    d.ix.workflowAttemptId,
  );
  if (!group) return;
  const groups = writableArray(d.next, 'taskGroups');
  if (at !== undefined) groups[at] = group;
  else d.ix.taskGroupIndex.set(event.id, groups.push(group) - 1);
  d.touched = true;
}

// A card is a monotone machine: it opens once, takes progress while it is
// open, and closes once. A second start reopens a running card (a re-run
// attempt) and is a no-op on a closed one; progress after the close and a
// close without an open are dropped. Under the one publisher those rows cannot
// arrive out of order, so nothing here compensates for a race; the shape is
// the card's definition.
function record(d: Draft, event: TranscriptEvent): void {
  const { ix, ctx } = d;
  switch (event.type) {
    case 'log':
    case 'usage':
    case 'domain':
      recordLogRow(d, event);
      return;

    case 'stage.start': {
      // A new model-turn boundary starts fresh: whatever MODEL_RESPONSE
      // stream the previous turn may have opened is no longer this turn's
      // to reuse. Tool-use turns are session stages containing several
      // inner model/tool rounds, while other flows expose round stages.
      if (event.kind === 'round' || event.kind === 'session') {
        ix.pendingModelResponseId = undefined;
      }
      const index = event.index ?? undefined;
      const total = event.total ?? undefined;
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
        ...(event.kind === 'phase'
          ? {
              phase: {
                ...(index !== undefined ? { index } : {}),
                ...(total !== undefined ? { total } : {}),
              },
            }
          : {}),
        open: true,
      });
      foldTaskGroup(d, event);
      return;
    }

    case 'stage.end': {
      const slot = ix.slots.get(event.id);
      if (slot?.kind === 'stage') {
        slot.open = false;
        write(d, slot);
      }
      foldTaskGroup(d, event);
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
        status: TOOL_CALL_STATUS.IN_PROGRESS,
      } satisfies ToolUseLog;
      const slot = ix.slots.get(event.logId);
      if (slot) {
        if (slot.kind === 'tool' && ix.activeTools.has(event.logId)) {
          slot.log = log;
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
      slot.log = decodeToolUseLog({
        ...(isObject(event.result) ? event.result : {}),
        status: event.status,
      });
      if (!inProgress) {
        slot.base = settle(ix, slot.base);
        ix.activeTools.delete(event.logId);
      }
      write(d, slot);
      return;
    }

    case 'workflow.call': {
      const { call, logId, stageId } = event;
      const level: LogLevel = call.status === 'failed' ? 'error' : 'info';
      const terminal = isTerminalWorkflowCallProgress(call);
      const slot = ix.slots.get(logId);
      if (slot?.kind === 'call') {
        // The latest call names the card's level and stage.
        const { groupId: _stage, ...rest } = slot.base;
        const base = {
          ...rest,
          level,
          ...(stageId !== undefined ? { groupId: stageId } : {}),
        };
        slot.base = terminal ? settle(ix, base) : base;
        slot.call = call;
        write(d, slot);
        return;
      }
      write(d, {
        kind: 'call',
        base: open(
          d,
          logId,
          stageId,
          MESSAGE_TYPES.WORKFLOW_TASK,
          terminal,
          level,
        ),
        call,
      });
      return;
    }

    case 'workflow.plan':
      ix.workflowAttemptId = event.attemptId;
      ix.plan = { phases: [...event.phases], tasks: [...event.tasks] };
      d.touched = true;
      return;

    // The run's facts, not transcript rows: `context.state` folds into
    // `RunView.context`, and the newest `skills.snapshot` is read from the
    // run's committed rows by the one surface that shows it.
    case 'skills.snapshot':
    case 'context.state':
      return;

    case 'stream.start': {
      if (ix.closed) return;
      const messageType = asMessageType(event.kind);
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
      // already wrote a (possibly raw, pre-replacement) row, reconcile it to
      // the authoritative text and close the stream, so no later stream.end
      // or boundary settlement can replace that text; otherwise this round
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
      });
      return;
    }
  }
}

/** Settle a text row, with its final text when one is given. */
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

/** The lifecycle rows move the transcript boundary: a parked or ended run
 *  closes every open stream and fails every open card. */
function boundaryPhase(event: SessionEvent): RunPhase | undefined {
  switch (event.type) {
    case 'run.activate':
      return RUN_PHASE.RUNNING;
    case 'flow.step':
      if (event.payload.step === 'halted') return undefined;
      return event.payload.step === 'waiting'
        ? RUN_PHASE.WAITING
        : RUN_PHASE.RUNNING;
    case 'child.park':
      return event.phase === 'parked' ? RUN_PHASE.WAITING : RUN_PHASE.RUNNING;
    case 'run.end':
      return event.outcome;
    default:
      return undefined;
  }
}

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
      error: 'The run ended before this tool completed.',
    };
    write(d, slot);
  }
  ix.activeTools.clear();
}

/**
 * Fold one session event into a run's transcript. Returns the same value
 * when the event changed nothing the transcript holds.
 */
export function foldTranscriptEvent(
  transcript: TranscriptView,
  event: SessionEvent,
  ctx: TranscriptContext,
): TranscriptView {
  const d: Draft = {
    ix: indexesOf(transcript),
    next: replaceTranscript(transcript, {}),
    ctx,
    at: event.at,
    stampId: JSON.stringify([event.aggregateId, event.seq]),
    written: [],
    touched: false,
  };
  const phase = boundaryPhase(event);
  if (phase !== undefined) moveBoundary(d, phase);
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
        upsertCompactionRows(d.next, changed);
        d.touched = true;
      }
    }
  }
  for (const slot of d.written) paint(d, slot);
  return d.touched ? d.next : transcript;
}

/**
 * One aggregate's transcript, folded cold from its committed rows by the same
 * reducer the session view runs: where no view is resident (export, a parked
 * run's closure, host exit). Empty when the run has no rows. `settledRows`
 * stays 0: only the live session fold advances that prefix, so a cold read
 * uses `rows` and `openWork`, never `settledRows`.
 */
export function foldRunTranscript(
  events: readonly SessionEvent[],
  debug: boolean,
): TranscriptView {
  resetTranscriptOwnership();
  let transcript = emptyTranscript();
  const start = events[0];
  if (start === undefined) return transcript;
  if (start.type !== 'run.start' || start.seq !== 1) {
    throw new Error('A transcript read must begin with its creation row.');
  }
  const ctx: TranscriptContext = {
    debug,
    lifecycleToTaskGroups: lifecycleToTaskGroups(start),
  };
  for (const event of events) {
    transcript = foldTranscriptEvent(transcript, event, ctx);
  }
  return transcript;
}
