/**
 * The one fold (PRD one-fold-three-renderers, G1 and 5.2): `fold(view,
 * input)` turns the durable session events, live text chunks, and owner
 * liveness snapshots into `SessionView`. Every process that shows a session
 * runs it; the transport carries its input, never its output.
 *
 * Pure in the sense that matters: no IO, no clock, no platform, no store
 * reads, and the same input sequence yields the same view. Incremental in
 * the sense the PRD requires: an event recomputes the arm for its stream,
 * walks `parentId` to the root refreshing each ancestor's `childIds`,
 * `rollup`, `approval`, and `group` (and, at the direct parent of a
 * workflow-script run, the run model), then touches `order` only when a
 * top-level stream appeared, moved, or left. O(depth) per event, never a
 * whole-view pass.
 *
 * The accumulator contract that makes this O(depth): `view.streams`,
 * `view.policy`, and `view.queuedFollowUps` are indexes reused across folds,
 * and a transcript's arrays are appended in place (a copy per entry would
 * make a replay quadratic). Every `StreamView` value, every `TranscriptView`
 * value, and the `SessionView` envelope are replaced on change and never
 * mutated, so a host that compares those by identity sees exactly what
 * changed. A caller holds the latest view only.
 */
import {
  AgentCategory,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_PHASE,
  STREAM_STATUS,
  STREAMING_TEXT_MESSAGE_TYPES,
  runIdentityDisplayName,
  sumUsageStats,
  type FoldInput,
  type SessionEvent,
  type StreamLogEntry,
  type StreamTabId,
} from '@shared/schemas';
import {
  compactionActivityRow,
  projectTranscriptRow,
  type TranscriptRow,
} from '@shared/transcript';
import { getModelLabel } from '@shared/model/modelLabel';
import {
  applyCompactionActivityEntries,
  createCompactionActivityProjection,
  settleCompactionActivities,
} from '@shared/streams/compactionActivityProjection';
import { streamStageFromStageStart } from '@shared/streams/stage';
import {
  compareByNewestCreationTime,
  compareBySeqNo,
} from '@shared/streams/streamOrdering';
import {
  isInFlightPhase,
  isTerminalOutcomePhase,
  isTranscriptSettlementPhase,
  workflowRunSettled,
} from '@shared/streams/streamStatus';
import {
  formatStreamStatusLabel,
  streamStatusTone,
} from '@shared/streams/streamStatusDisplay';
import { upsertTaskGroupFromStreamLog } from '@shared/streams/taskGroupProjection';
import {
  workflowMarkerOf,
  workflowRunModel,
  type ChildRunProgress,
} from '@shared/streams/workflowRunModel';
import { isObject, roundTo } from '@utils/core';

import type {
  SessionView,
  StreamView,
  StreamingText,
  TranscriptView,
} from './sessionView';

type DurableEvent = SessionEvent;
type TextChunk = Extract<FoldInput, { type: 'text.chunk' }>;
type OwnerLiveness = Extract<FoldInput, { type: 'owner.liveness' }>;

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export function fold(view: SessionView, input: FoldInput): SessionView {
  // The envelope is replaced, never mutated: work on a copy whose indexes
  // are shared with the previous value.
  const next: SessionView = { ...view };
  switch (input.type) {
    case 'text.chunk':
      return foldTextChunk(next, input) ? next : view;
    case 'owner.liveness':
      foldOwnerLiveness(next, input);
      return next;
    default:
      return foldDurable(next, input) ? next : view;
  }
}

// ---------------------------------------------------------------------------
// Stream construction
// ---------------------------------------------------------------------------

/** The label an identity-less stream shows: its id's name prefix. */
function streamIdDisplayName(streamId: StreamTabId): string {
  const separator = streamId.indexOf('#');
  return separator <= 0 ? streamId : streamId.slice(0, separator);
}

function emptyTranscript(): TranscriptView {
  const compactionState = createCompactionActivityProjection();
  return {
    rows: [],
    taskGroups: [],
    compaction: compactionState.blocks,
    settledSeq: 0,
    run: null,
    rowIndex: new Map(),
    taskGroupIndex: new Map(),
    compactionState,
    streaming: new Map(),
    plan: undefined,
    workflowAttemptId: undefined,
  };
}

const NO_ROUNDS = Object.freeze({});

/** The arm-specific keys `withCategory` drops when a stream re-arms. */
const ARM_KEYS = new Set([
  'category',
  'todos',
  'plan',
  'goal',
  'outputs',
  'files',
  'missingOutputs',
  'compileFailures',
]);

/**
 * A stream in its initial shape. `run.start` normally mints it; a fact that
 * names a stream before its `run.start` has landed (a parent edge from
 * registration, an imported row) mints the same shape with no identity and
 * the later `run.start` completes it. A run with no category (a process
 * stream, a legacy import) takes the tool-use arm, as roster provisioning
 * does today.
 */
function createStream(
  id: StreamTabId,
  category: StreamView['category'],
  timestamp: number,
): StreamView {
  const status = STREAM_STATUS.READY;
  const common = {
    id,
    identity: null,
    executionId: null,
    isRemote: false,
    ownerId: null,
    label: streamIdDisplayName(id),
    description: null,
    model: null,
    modelLabel: null,
    command: null,
    worktree: null,
    status,
    substate: null,
    statusDetail: null,
    statusLabel: formatStreamStatusLabel(status),
    tone: streamStatusTone(status),
    runStartedAt: null,
    lastTimestamp: null,
    creationTimestamp: timestamp,
    conversationProgress: { toolCallCount: 0 },
    stage: null,
    followUpSupport: 'unsupported' as const,
    contextState: null,
    parentId: null,
    ancestors: [],
    childIds: [],
    rollup: { total: 0, running: 0, finished: 0 },
    approval: 'none' as const,
    group: 'recent' as const,
    usage: {},
    transcript: emptyTranscript(),
  };
  return category === AgentCategory.Workflow
    ? {
        ...common,
        category,
        files: NO_ROUNDS,
        missingOutputs: NO_ROUNDS,
        compileFailures: NO_ROUNDS,
      }
    : {
        ...common,
        category: AgentCategory.ToolUse,
        todos: [],
        plan: null,
        goal: { active: false },
        outputs: NO_ROUNDS,
        missingOutputs: NO_ROUNDS,
        compileFailures: NO_ROUNDS,
      };
}

/** Re-arm a stream when `run.start` names a different category. */
function withCategory(
  stream: StreamView,
  category: StreamView['category'],
): StreamView {
  if (stream.category === category) return stream;
  const common = Object.fromEntries(
    Object.entries(stream).filter(([key]) => !ARM_KEYS.has(key)),
  );
  return {
    ...createStream(stream.id, category, stream.creationTimestamp),
    ...common,
  } as StreamView;
}

// ---------------------------------------------------------------------------
// Ordering and topology
// ---------------------------------------------------------------------------

function isTopLevel(view: SessionView, stream: StreamView): boolean {
  return stream.parentId === null || !view.streams.has(stream.parentId);
}

function orderingKey(stream: StreamView): {
  name: string;
  creationTimestamp: number;
} {
  return { name: stream.id, creationTimestamp: stream.creationTimestamp };
}

/** `ids` with `id` placed by the `streamOrdering` rule. */
function insertOrdered(
  view: SessionView,
  ids: readonly StreamTabId[],
  id: StreamTabId,
): StreamTabId[] {
  const next = ids.filter((existing) => existing !== id);
  const key = orderingKey(view.streams.get(id)!);
  let at = next.length;
  for (let i = 0; i < next.length; i += 1) {
    const other = view.streams.get(next[i]);
    if (other && compareByNewestCreationTime(key, orderingKey(other)) < 0) {
      at = i;
      break;
    }
  }
  next.splice(at, 0, id);
  return next;
}

function withoutId(
  ids: readonly StreamTabId[],
  id: StreamTabId,
): StreamTabId[] {
  return ids.filter((existing) => existing !== id);
}

function ancestorsOf(
  view: SessionView,
  stream: StreamView,
): StreamView['ancestors'] {
  const chain: StreamView['ancestors'] = [];
  const seen = new Set<StreamTabId>([stream.id]);
  let parentId = stream.parentId;
  while (parentId !== null && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = view.streams.get(parentId);
    if (!parent) {
      // An evicted parent keeps the label this stream last saw for it, and
      // the chain above it, which nothing can recompute any more.
      const known = stream.ancestors.findIndex((a) => a.id === parentId);
      const kept =
        known >= 0
          ? stream.ancestors.slice(0, known + 1)
          : [{ id: parentId, label: streamIdDisplayName(parentId) }];
      return [...kept, ...chain];
    }
    chain.unshift({ id: parent.id, label: parent.label });
    parentId = parent.parentId;
  }
  return chain;
}

/** Recompute `ancestors` for a stream and its descendants (a moved subtree,
 *  or a relabelled parent). O(subtree), once per such change. */
function refreshAncestors(view: SessionView, streamId: StreamTabId): void {
  const stream = view.streams.get(streamId);
  if (!stream) return;
  const ancestors = ancestorsOf(view, stream);
  const unchanged =
    ancestors.length === stream.ancestors.length &&
    ancestors.every(
      (a, i) =>
        a.id === stream.ancestors[i].id &&
        a.label === stream.ancestors[i].label,
    );
  if (!unchanged) view.streams.set(streamId, { ...stream, ancestors });
  for (const childId of stream.childIds) refreshAncestors(view, childId);
}

// ---------------------------------------------------------------------------
// Derived per-stream facts
// ---------------------------------------------------------------------------

/**
 * `group`, `approval`, and `rollup` from the stream's own facts and its
 * children. Waiting needs a live owner: without one the same pending request
 * folds to interrupted, never waiting, because nothing is listening for the
 * answer.
 */
function withAggregates(view: SessionView, stream: StreamView): StreamView {
  const pendingOwn = view.approvals.some((a) => a.streamId === stream.id);
  const ownerLive =
    stream.ownerId !== null && view.liveOwners.includes(stream.ownerId);
  const waiting = pendingOwn && ownerLive;
  const rollup = { total: 0, running: 0, finished: 0 };
  let descendantWaiting = false;
  for (const childId of stream.childIds) {
    const child = view.streams.get(childId);
    if (!child) continue;
    rollup.total += 1 + child.rollup.total;
    rollup.running +=
      (isInFlightPhase(child.status) ? 1 : 0) + child.rollup.running;
    rollup.finished +=
      (isTerminalOutcomePhase(child.status) ? 1 : 0) + child.rollup.finished;
    if (child.approval !== 'none') descendantWaiting = true;
  }
  let group: StreamView['group'] = 'recent';
  if (waiting) group = 'waiting';
  else if (!pendingOwn && isInFlightPhase(stream.status)) group = 'running';
  let approval: StreamView['approval'] = 'none';
  if (waiting) approval = 'own';
  else if (descendantWaiting) approval = 'descendant';
  if (
    stream.group === group &&
    stream.approval === approval &&
    stream.rollup.total === rollup.total &&
    stream.rollup.running === rollup.running &&
    stream.rollup.finished === rollup.finished
  ) {
    return stream;
  }
  return { ...stream, group, approval, rollup };
}

function withStatusCopy(stream: StreamView): StreamView {
  const substate = stream.substate ?? undefined;
  return {
    ...stream,
    statusLabel: formatStreamStatusLabel(stream.status, { substate }),
    tone: streamStatusTone(stream.status, substate),
  };
}

// ---------------------------------------------------------------------------
// Workflow-script run model
// ---------------------------------------------------------------------------

function isWorkflowScriptRun(stream: StreamView): boolean {
  return stream.identity?.kind === 'multiAgentWorkflow';
}

function childProgressOf(child: StreamView): ChildRunProgress {
  const totals = sumUsageStats(Object.values(child.usage));
  return {
    ...(child.runStartedAt === null
      ? {}
      : { runStartedAt: child.runStartedAt }),
    toolCallCount: child.conversationProgress.toolCallCount,
    outputTokens: totals.outputTokens,
    costUsd: totals.cost,
  };
}

/** Whether a child's change is one its parent's run board shows live. */
function childProgressChanged(prev: StreamView, next: StreamView): boolean {
  return (
    prev.status !== next.status ||
    prev.runStartedAt !== next.runStartedAt ||
    prev.conversationProgress !== next.conversationProgress ||
    prev.usage !== next.usage
  );
}

/**
 * `transcript.run` for a workflow-script run. Memoized on the stream's
 * `settledSeq`: its own durable event recomputes it, a direct child's
 * progress change reaches it through the ancestor walk, a text chunk never
 * does.
 */
function withRunModel(view: SessionView, stream: StreamView): StreamView {
  if (!isWorkflowScriptRun(stream)) return stream;
  const childProgress = new Map<StreamTabId, ChildRunProgress>();
  for (const childId of stream.childIds) {
    const child = view.streams.get(childId);
    if (child) childProgress.set(childId, childProgressOf(child));
  }
  const transcript = stream.transcript;
  const run = workflowRunModel({
    taskGroups: transcript.taskGroups,
    rows: transcript.rows,
    workflowAttemptId: transcript.workflowAttemptId,
    plan: transcript.plan,
    runSettled: workflowRunSettled(stream.status),
    childProgress,
  });
  return { ...stream, transcript: { ...transcript, run } };
}

/**
 * Re-derive the aggregates of `startId` and every ancestor above it. The run
 * model is recomputed at `runModelAt` only: a board joins its direct
 * children's progress, so a grandchild's change stops at its own parent.
 */
function walkUp(
  view: SessionView,
  startId: StreamTabId | null,
  runModelAt: StreamTabId | null,
): void {
  const seen = new Set<StreamTabId>();
  let id = startId;
  while (id !== null && !seen.has(id)) {
    seen.add(id);
    const current = view.streams.get(id);
    if (!current) return;
    let next = withAggregates(view, current);
    if (id === runModelAt) next = withRunModel(view, next);
    if (next !== current) view.streams.set(id, next);
    id = current.parentId;
  }
}

// ---------------------------------------------------------------------------
// Transcript slice
// ---------------------------------------------------------------------------

function upsertRow(transcript: TranscriptView, row: TranscriptRow): void {
  const { rows, rowIndex } = transcript;
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

function rowById(
  transcript: TranscriptView,
  id: string,
): TranscriptRow | undefined {
  const at = transcript.rowIndex.get(id);
  return at === undefined ? undefined : transcript.rows[at];
}

function reconcileCompactionRows(
  transcript: TranscriptView,
  changedIndices: readonly number[],
): void {
  for (const blockIndex of changedIndices) {
    const block = transcript.compactionState.blocks[blockIndex];
    if (block) upsertRow(transcript, compactionActivityRow(block));
  }
}

function isStreamingEntry(entry: StreamLogEntry): boolean {
  return (
    entry.type === STREAM_LOG_ENTRY_TYPES.LOG &&
    STREAMING_TEXT_MESSAGE_TYPES.has(entry.messageType ?? '') &&
    isObject(entry.data) &&
    entry.data.status === 'running'
  );
}

function materialize(text: StreamingText): string {
  if (text.chunks.length > 0) {
    text.joined += text.chunks.join('');
    text.chunks.length = 0;
  }
  return text.joined;
}

function projectRow(transcript: TranscriptView, entry: StreamLogEntry): void {
  const row = projectTranscriptRow(entry, {
    previousRow: rowById(transcript, entry.id),
    projectLifecycleToTaskGroups: true,
  });
  if (row) upsertRow(transcript, row);
}

/** Fold one imported transcript row into the slice: the row, task-group,
 *  compaction, and run-marker reducers, each called unchanged. */
function applyEntry(
  transcript: TranscriptView,
  entry: StreamLogEntry,
): TranscriptView {
  const next: TranscriptView = { ...transcript };
  upsertTaskGroupFromStreamLog(next.taskGroups, next.taskGroupIndex, entry);
  const marker = workflowMarkerOf(entry);
  if (marker) {
    Object.assign(next, {
      workflowAttemptId: marker.attemptId ?? next.workflowAttemptId,
      plan: marker.kind === 'plan' ? marker.plan : undefined,
    });
  }
  reconcileCompactionRows(
    next,
    applyCompactionActivityEntries(next.compactionState, [entry]),
  );
  if (isStreamingEntry(entry)) {
    const text = entry.text ?? '';
    next.streaming.set(entry.id, {
      entry,
      joined: text,
      chunks: [],
      length: text.length,
      lastChunkIndex: -1,
    });
  } else {
    next.streaming.delete(entry.id);
  }
  projectRow(next, entry);
  return next;
}

/** Finalize unmatched compaction starts when the turn settles. */
function withSettledTranscript(
  stream: StreamView,
  finishedAt: number,
): StreamView {
  if (!isTranscriptSettlementPhase(stream.status)) return stream;
  const transcript: TranscriptView = { ...stream.transcript };
  const changed = settleCompactionActivities(transcript.compactionState, {
    finishedAt,
  });
  if (changed.length === 0) return stream;
  reconcileCompactionRows(transcript, changed);
  return { ...stream, transcript };
}

/** Returns whether the chunk changed anything. */
function foldTextChunk(view: SessionView, chunk: TextChunk): boolean {
  const stream = view.streams.get(chunk.streamId);
  const text = stream?.transcript.streaming.get(chunk.entryId);
  // A chunk for a row this process has not seen, or one already applied
  // (a resync replays the inflight tail), changes nothing: the next durable
  // entry for the row carries its full text.
  if (!stream || !text || chunk.chunkIndex <= text.lastChunkIndex) {
    return false;
  }
  text.chunks.push(chunk.text);
  text.length += chunk.text.length;
  text.lastChunkIndex = chunk.chunkIndex;
  const transcript: TranscriptView = { ...stream.transcript };
  projectRow(transcript, { ...text.entry, text: materialize(text) });
  view.streams.set(stream.id, { ...stream, transcript });
  return true;
}

// ---------------------------------------------------------------------------
// Durable events
// ---------------------------------------------------------------------------

/** The stream a fact names, minted if the fact precedes its `run.start`. */
function ensureStream(
  view: SessionView,
  streamId: StreamTabId,
  timestamp: number,
): StreamView {
  const existing = view.streams.get(streamId);
  if (existing) return existing;
  const minted = createStream(streamId, AgentCategory.ToolUse, timestamp);
  view.streams.set(streamId, minted);
  view.order = insertOrdered(view, view.order, streamId);
  return minted;
}

function mergeRounds<T extends Record<number, unknown>>(
  current: T,
  incoming: T,
): T {
  return { ...current, ...incoming };
}

/** The event's own arm applied to its stream (topology and session slices
 *  are handled by the caller). */
function applyOwnArm(stream: StreamView, event: DurableEvent): StreamView {
  switch (event.type) {
    case 'run.start': {
      const placeholder = stream.executionId === null;
      const identity = event.identity ?? stream.identity;
      const armed = withCategory(
        stream,
        event.agentCategory ?? stream.category,
      );
      return {
        ...armed,
        identity,
        executionId: event.executionId,
        isRemote: event.isRemote ?? armed.isRemote,
        label: identity
          ? runIdentityDisplayName(identity)
          : streamIdDisplayName(stream.id),
        worktree: event.worktree ?? armed.worktree,
        followUpSupport: event.userFollowUpSupport ?? armed.followUpSupport,
        // The ordering key is the first run.start; a resume keeps its place.
        creationTimestamp: placeholder
          ? event.timestamp
          : armed.creationTimestamp,
        parentId: event.parentStreamId ?? armed.parentId,
      };
    }
    case 'run.config': {
      const model =
        stream.identity?.kind === 'agent' ? (event.config.model ?? null) : null;
      return {
        ...stream,
        model,
        modelLabel: model === null ? null : getModelLabel(model),
        command:
          stream.identity?.kind === 'process'
            ? (event.config.instruction ?? null)
            : null,
      };
    }
    case 'status': {
      const freshRun =
        event.phase === STREAM_PHASE.RUNNING &&
        event.previousPhase !== STREAM_PHASE.RUNNING;
      return withSettledTranscript(
        withStatusCopy({
          ...stream,
          status: event.phase,
          substate: event.substate ?? null,
          runStartedAt: event.runStartedAt ?? null,
          ...(freshRun
            ? { stage: null, conversationProgress: { toolCallCount: 0 } }
            : {}),
        }),
        event.timestamp,
      );
    }
    case 'result':
      return withSettledTranscript(
        withStatusCopy({
          ...stream,
          status: event.outcome,
          substate: null,
          runStartedAt: null,
        }),
        event.timestamp,
      );
    case 'stage.start': {
      const stage = streamStageFromStageStart({
        kind: event.kind ?? undefined,
        label: event.label,
        index: event.index ?? undefined,
        total: event.total ?? undefined,
      });
      return stage ? { ...stream, stage } : stream;
    }
    case 'conversation.progress':
      return { ...stream, conversationProgress: event.progress };
    case 'usage':
      return {
        ...stream,
        usage: { ...stream.usage, [event.storageKey]: event.usage },
      };
    case 'context.state':
      return {
        ...stream,
        contextState: {
          inputTokens: event.inputTokens,
          contextWindow: event.contextWindow,
          utilizationPercent: roundTo(
            (event.inputTokens / event.contextWindow) * 100,
            1,
          ),
        },
      };
    case 'updateTodos':
      return stream.category === AgentCategory.ToolUse
        ? { ...stream, todos: event.todos }
        : stream;
    case 'updatePlan':
      return stream.category === AgentCategory.ToolUse
        ? { ...stream, plan: event.plan }
        : stream;
    case 'goalStateChanged':
      return stream.category === AgentCategory.ToolUse
        ? { ...stream, goal: event.state }
        : stream;
    case 'goalPaused':
      // The pause itself lands as the next `goalStateChanged`; hosts surface
      // the notice from the fact, not from a view field.
      return stream;
    case 'addOutputFiles':
      return stream.category === AgentCategory.Workflow
        ? { ...stream, files: mergeRounds(stream.files, event.filesByRound) }
        : {
            ...stream,
            outputs: mergeRounds(stream.outputs, event.filesByRound),
          };
    case 'updateMissingOutputs':
      return {
        ...stream,
        missingOutputs: mergeRounds(stream.missingOutputs, event.filesByRound),
      };
    case 'updateCompileFailures':
      return {
        ...stream,
        compileFailures: mergeRounds(
          stream.compileFailures,
          event.filesByRound,
        ),
      };
    case 'workflow.call':
    case 'workflow.plan':
      // Until the events-to-row collapse (post-cutover), the card and the plan
      // marker reach the transcript as `legacy.entry` rows, which the run
      // model reads; the trace arms only advance `settledSeq`.
      return stream;
    case 'setParentStream':
      return event.parentStreamId === stream.parentId
        ? stream
        : { ...stream, parentId: event.parentStreamId };
    case 'updateStreamDescription':
      return { ...stream, description: event.description };
    case 'legacy.entry':
      return {
        ...stream,
        transcript: applyEntry(stream.transcript, event.entry),
      };
    case 'approval.requested':
    case 'approval.resolved':
    case 'approval.policy':
    case 'inquiryThreadUpdated':
    case 'updateQueuedFollowUps':
    case 'removeStream':
      return stream;
  }
}

/** Session-level slices, applied before the stream arm so the arm's
 *  aggregates see them. */
function applySessionSlices(view: SessionView, event: DurableEvent): void {
  switch (event.type) {
    case 'approval.requested':
      view.approvals = [
        ...view.approvals,
        {
          streamId: event.streamId,
          requestId: event.requestId,
          payload: event.payload,
        },
      ];
      return;
    case 'approval.resolved':
      view.approvals = view.approvals.filter(
        (a) => a.requestId !== event.requestId,
      );
      return;
    case 'approval.policy':
      view.policy.set(event.streamId, event.snapshot);
      return;
    case 'inquiryThreadUpdated': {
      const {
        type: _type,
        streamId: _streamId,
        seq: _seq,
        ownerId: _ownerId,
        timestamp: _timestamp,
        ...thread
      } = event;
      const at = view.inquiries.findIndex(
        (i) => i.threadId === thread.threadId,
      );
      view.inquiries =
        at === -1
          ? [...view.inquiries, thread]
          : view.inquiries.with(at, thread);
      return;
    }
    case 'updateQueuedFollowUps':
      view.queuedFollowUps.set(event.streamId, event.messages);
      return;
    default:
      return;
  }
}

/** Move `stream` from `previousParentId` to its current parent. */
function relink(
  view: SessionView,
  stream: StreamView,
  previousParentId: StreamTabId | null,
): void {
  const wasTopLevel =
    previousParentId === null || !view.streams.has(previousParentId);
  const previousParent =
    previousParentId === null ? undefined : view.streams.get(previousParentId);
  if (previousParent) {
    view.streams.set(previousParent.id, {
      ...previousParent,
      childIds: withoutId(previousParent.childIds, stream.id),
    });
  }
  if (stream.parentId !== null) {
    const parent = ensureStream(
      view,
      stream.parentId,
      stream.creationTimestamp,
    );
    view.streams.set(parent.id, {
      ...parent,
      childIds: insertOrdered(view, parent.childIds, stream.id),
    });
  }
  const topLevel = isTopLevel(view, stream);
  if (wasTopLevel && !topLevel) view.order = withoutId(view.order, stream.id);
  if (!wasTopLevel && topLevel) {
    view.order = insertOrdered(view, view.order, stream.id);
  }
  refreshAncestors(view, stream.id);
}

/** Returns whether the event changed anything. */
function foldDurable(view: SessionView, event: DurableEvent): boolean {
  const known = view.streams.get(event.streamId);
  // At-least-once delivery: a seq this stream has already folded is a replay.
  if (known && event.seq <= known.transcript.settledSeq) return false;
  if (event.type === 'removeStream') return foldRemoveStream(view, event);

  applySessionSlices(view, event);
  const before = ensureStream(view, event.streamId, event.timestamp);
  const own = applyOwnArm(before, event);
  let next: StreamView = {
    ...own,
    ownerId: event.ownerId,
    lastTimestamp: event.timestamp,
    transcript: { ...own.transcript, settledSeq: event.seq },
  };
  view.streams.set(next.id, next);

  if (next.parentId !== before.parentId) {
    relink(view, next, before.parentId);
    walkUp(view, before.parentId, before.parentId);
  } else if (next.creationTimestamp !== before.creationTimestamp) {
    // A placeholder gained its run.start: its ordering key is now real.
    if (isTopLevel(view, next)) {
      view.order = insertOrdered(view, view.order, next.id);
    } else {
      const parent = view.streams.get(next.parentId!)!;
      view.streams.set(parent.id, {
        ...parent,
        childIds: insertOrdered(view, parent.childIds, next.id),
      });
    }
  }
  if (next.label !== before.label) {
    for (const childId of next.childIds) refreshAncestors(view, childId);
  }
  next = view.streams.get(next.id)!;
  // Its own durable event advanced `settledSeq`: the memo key moved.
  view.streams.set(next.id, withRunModel(view, withAggregates(view, next)));
  walkUp(
    view,
    next.parentId,
    childProgressChanged(before, next) ? next.parentId : null,
  );
  return true;
}

function foldRemoveStream(view: SessionView, event: DurableEvent): boolean {
  const stream = view.streams.get(event.streamId);
  if (!stream) return false;
  view.streams.delete(stream.id);
  view.policy.delete(stream.id);
  view.queuedFollowUps.delete(stream.id);
  if (view.approvals.some((a) => a.streamId === stream.id)) {
    view.approvals = view.approvals.filter((a) => a.streamId !== stream.id);
  }
  view.order = withoutId(view.order, stream.id);
  const parent =
    stream.parentId === null ? undefined : view.streams.get(stream.parentId);
  if (parent) {
    view.streams.set(parent.id, {
      ...parent,
      childIds: withoutId(parent.childIds, stream.id),
    });
    walkUp(view, parent.id, parent.id);
  }
  // Orphans surface at the top level; their `ancestors` keep the evicted
  // label, so nothing above them is lost to the reader.
  for (const childId of stream.childIds) {
    if (view.streams.has(childId)) {
      view.order = insertOrdered(view, view.order, childId);
    }
  }
  return true;
}

function foldOwnerLiveness(view: SessionView, snapshot: OwnerLiveness): void {
  view.liveOwners = [...snapshot.owners];
  // Only a stream with a pending request can change group on liveness; the
  // approvals list names them, so no whole-view pass.
  const touched = new Set<StreamTabId>(view.approvals.map((a) => a.streamId));
  for (const streamId of touched) walkUp(view, streamId, null);
}
