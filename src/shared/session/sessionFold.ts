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
 * `rollup`, `approval`, and `group`, then touches `order` only when a
 * top-level stream appeared, moved, or left. O(depth) per event, never a
 * whole-view pass. A text chunk costs the chunk, never the row's text.
 *
 * Existence: a stream exists iff its `run.start` has been folded. A fact
 * that names any other stream changes nothing (the caller that stamps the
 * envelope logs it); a parent edge to a stream the view has no `run.start`
 * for leaves the child top-level with the edge kept in `ancestors`.
 *
 * The run model (`transcript.run`) is derived only when one of its inputs
 * moved: the stream's own `run.start`, a status change, a transcript entry
 * the model reads (a workflow card, a group boundary, a plan marker), or a
 * direct child's progress. Folding a frame defers that derivation to the end
 * of the frame, so a replay of R events derives each touched board once.
 *
 * The accumulator contract that makes this O(depth): `view.streams`,
 * `view.policy`, and `view.queuedFollowUps` are indexes reused across folds,
 * a transcript's arrays are appended in place (a copy per entry would make a
 * replay quadratic), and the fold's own indexes over a transcript live in a
 * module-private map keyed by the transcript value. Every `StreamView`
 * value, every `TranscriptView` value, and the `SessionView` envelope are
 * replaced on change and never mutated, so a host that compares those by
 * identity sees exactly what changed. A caller holds the latest view only.
 */
import {
  AgentCategory,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_PHASE,
  STREAM_STATUS,
  STREAMING_TEXT_MESSAGE_TYPES,
  runIdentityDisplayName,
  sumUsageStats,
  type FoldInput,
  type RoundIndexed,
  type SessionEvent,
  type StreamLogEntry,
  type StreamTabId,
  type WorkflowDeclaredPlan,
} from '@shared/schemas';
import {
  compactionActivityRow,
  projectTranscriptRow,
  type TranscriptRow,
} from '@shared/transcript';
import { hasIncompleteEmbeddedSubagentFollowup } from '@shared/subagentFollowup';
import {
  appendTranscriptText,
  transcriptText,
  type TranscriptText,
} from '@shared/transcript/transcriptText';
import { getModelLabel } from '@shared/model/modelLabel';
import {
  applyCompactionActivityEntries,
  createCompactionActivityProjection,
  settleCompactionActivities,
  type CompactionActivityProjection,
} from '@shared/streams/compactionActivityProjection';
import { roundedUtilizationPercent } from '@shared/streams/contextUtilization';
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
  streamInterruptedMessage,
  streamStatusCopy,
} from '@shared/streams/streamStatusDisplay';
import { upsertTaskGroupFromStreamLog } from '@shared/streams/taskGroupProjection';
import {
  workflowMarkerOf,
  workflowRunModel,
  type ChildRunProgress,
} from '@shared/streams/workflowRunModel';
import { isObject } from '@utils/core';

import type { SessionView, StreamView, TranscriptView } from './sessionView';

type DurableEvent = SessionEvent;
type TextChunk = Extract<FoldInput, { type: 'text.chunk' }>;
type OwnerLiveness = Extract<FoldInput, { type: 'owner.liveness' }>;

/** Workflow-script stream ids whose run model a batch derives at its end. */
type DeferredRunModels = Set<StreamTabId> | null;

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/**
 * One input, or a frame of them (the transport's unit, 7.4 and 8.1) or a
 * replay: every input in order, with each touched workflow board's run model
 * derived once at the end instead of once per event.
 */
export function fold(
  view: SessionView,
  input: FoldInput | readonly FoldInput[],
): SessionView {
  if (!Array.isArray(input)) return foldWith(view, input as FoldInput, null);
  const deferred = new Set<StreamTabId>();
  let next = view;
  for (const each of input as readonly FoldInput[]) {
    next = foldWith(next, each, deferred);
  }
  for (const streamId of deferred) {
    const stream = next.streams.get(streamId);
    if (stream) next.streams.set(streamId, withRunModel(next, stream));
  }
  return next;
}

function foldWith(
  view: SessionView,
  input: FoldInput,
  deferred: DeferredRunModels,
): SessionView {
  // The envelope is replaced, never mutated: work on a copy whose indexes
  // are shared with the previous value.
  const next: SessionView = { ...view };
  switch (input.type) {
    case 'text.chunk':
      return foldTextChunk(next, input) ? next : view;
    case 'owner.liveness':
      foldOwnerLiveness(next, input, deferred);
      return next;
    default:
      return foldDurable(next, input, deferred) ? next : view;
  }
}

// ---------------------------------------------------------------------------
// Transcript indexes (fold-owned, never on the view)
// ---------------------------------------------------------------------------

/** One streaming row's live-text cursor. */
interface StreamingCursor {
  /** The last durable entry for the row: a first chunk projects it when the
   *  entry's own text was blank and gave no row. */
  readonly entry: StreamLogEntry;
  text: TranscriptText;
  /** The character `text.full` ends with, so no chunk flattens the text. */
  end: string;
  /** Index of the last chunk applied, so a resync's inflight replay is
   *  idempotent. */
  lastChunkIndex: number;
}

interface TranscriptIndexes {
  /** Row position by row id. */
  readonly rowIndex: Map<string, number>;
  /** Task-group position by group id. */
  readonly taskGroupIndex: Map<string, number>;
  /** The compaction projection's working state; `compaction` is its blocks. */
  readonly compactionState: CompactionActivityProjection;
  /** Live text per streaming entry id. */
  readonly streaming: Map<string, StreamingCursor>;
  /** The newest workflow plan marker, for the run model. */
  plan: WorkflowDeclaredPlan | undefined;
  /** The newest attempt boundary, even when its plan was malformed. */
  workflowAttemptId: string | undefined;
}

const INDEXES = new WeakMap<TranscriptView, TranscriptIndexes>();

function indexesOf(transcript: TranscriptView): TranscriptIndexes {
  const indexes = INDEXES.get(transcript);
  if (!indexes) {
    throw new Error('TranscriptView value was not created by the fold');
  }
  return indexes;
}

/** A replaced transcript value sharing the previous value's indexes. */
function replaceTranscript(
  transcript: TranscriptView,
  patch: Partial<TranscriptView>,
): TranscriptView {
  const next: TranscriptView = { ...transcript, ...patch };
  INDEXES.set(next, indexesOf(transcript));
  return next;
}

function emptyTranscript(): TranscriptView {
  const compactionState = createCompactionActivityProjection();
  const transcript: TranscriptView = {
    rows: [],
    taskGroups: [],
    compaction: compactionState.blocks,
    settledSeq: 0,
    run: null,
  };
  INDEXES.set(transcript, {
    rowIndex: new Map(),
    taskGroupIndex: new Map(),
    compactionState,
    streaming: new Map(),
    plan: undefined,
    workflowAttemptId: undefined,
  });
  return transcript;
}

// ---------------------------------------------------------------------------
// Stream construction
// ---------------------------------------------------------------------------

/** The label an identity-less stream shows: its id's name prefix. */
function streamIdDisplayName(streamId: StreamTabId): string {
  const separator = streamId.indexOf('#');
  return separator <= 0 ? streamId : streamId.slice(0, separator);
}

/**
 * A stream with no rounds recorded yet. Not `EMPTY_ROUND_INDEXED`: that is
 * the store's readonly view type (`ReadonlyRoundIndexed<never>`, numeric
 * keys, readonly arrays), which the schema-inferred round-keyed fields of
 * `StreamView` (`Record<string, T[]>`) do not accept.
 */
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
 * A stream in its initial shape, minted by its `run.start` alone. A run with
 * no category (a process stream, a legacy import) takes the tool-use arm, as
 * roster provisioning does today.
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
    ...streamStatusCopy(status),
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
  const stream = view.streams.get(id);
  if (!stream) return next;
  const key = orderingKey(stream);
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
      // A parent the view has no run.start for (evicted, or never replayed)
      // keeps the label this stream last saw for it, and the chain above it,
      // which nothing can recompute any more.
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
 * `group`, `approval`, `rollup`, and the status copy from the stream's own
 * facts and its children. Waiting needs a live owner: without one the same
 * pending request reads as interrupted (label, tone, and the resume notice
 * in `statusDetail`), never waiting, because nothing is listening for the
 * answer; the durable phase and the listed approval stay, so a resume can
 * re-ask.
 */
function withAggregates(view: SessionView, stream: StreamView): StreamView {
  const pendingOwn = view.approvals.some((a) => a.streamId === stream.id);
  const ownerLive =
    stream.ownerId !== null && view.liveOwners.includes(stream.ownerId);
  const waiting = pendingOwn && ownerLive;
  const interrupted = pendingOwn && !ownerLive;
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
  const copy = streamStatusCopy(stream.status, {
    substate: stream.substate ?? undefined,
    interrupted,
  });
  const statusDetail = interrupted ? streamInterruptedMessage() : null;
  if (
    stream.group === group &&
    stream.approval === approval &&
    stream.rollup.total === rollup.total &&
    stream.rollup.running === rollup.running &&
    stream.rollup.finished === rollup.finished &&
    stream.statusLabel === copy.statusLabel &&
    stream.tone === copy.tone &&
    stream.statusDetail === statusDetail
  ) {
    return stream;
  }
  return { ...stream, group, approval, rollup, ...copy, statusDetail };
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

/** Whether a child's change moved a value its parent's run board reads. */
function childProgressChanged(prev: StreamView, next: StreamView): boolean {
  if (prev === next) return false;
  if (
    prev.runStartedAt !== next.runStartedAt ||
    prev.conversationProgress.toolCallCount !==
      next.conversationProgress.toolCallCount
  ) {
    return true;
  }
  if (prev.usage === next.usage) return false;
  const before = sumUsageStats(Object.values(prev.usage));
  const after = sumUsageStats(Object.values(next.usage));
  return (
    before.outputTokens !== after.outputTokens || before.cost !== after.cost
  );
}

/** Whether an imported entry is one the run model reads: a group boundary
 *  (phases), a workflow card, or a plan marker. */
function entryAffectsRunModel(entry: StreamLogEntry): boolean {
  return (
    entry.type !== STREAM_LOG_ENTRY_TYPES.LOG ||
    entry.messageType === MESSAGE_TYPES.WORKFLOW_TASK ||
    workflowMarkerOf(entry) !== undefined
  );
}

/** `transcript.run` for a workflow-script run, derived now. */
function withRunModel(view: SessionView, stream: StreamView): StreamView {
  if (!isWorkflowScriptRun(stream)) return stream;
  const childProgress = new Map<StreamTabId, ChildRunProgress>();
  for (const childId of stream.childIds) {
    const child = view.streams.get(childId);
    if (child) childProgress.set(childId, childProgressOf(child));
  }
  const transcript = stream.transcript;
  const indexes = indexesOf(transcript);
  const run = workflowRunModel({
    taskGroups: transcript.taskGroups,
    rows: transcript.rows,
    workflowAttemptId: indexes.workflowAttemptId,
    plan: indexes.plan,
    runSettled: workflowRunSettled(stream.status),
    childProgress,
  });
  return { ...stream, transcript: replaceTranscript(transcript, { run }) };
}

/** Derive the run model now, or note the stream for the end of the batch. */
function runModelAt(
  view: SessionView,
  stream: StreamView,
  deferred: DeferredRunModels,
): StreamView {
  if (!isWorkflowScriptRun(stream)) return stream;
  if (deferred) {
    deferred.add(stream.id);
    return stream;
  }
  return withRunModel(view, stream);
}

/**
 * Re-derive the aggregates of `startId` and every ancestor above it. The run
 * model is re-derived at `boardId` only: a board joins its direct children's
 * progress, so a grandchild's change stops at its own parent.
 */
function walkUp(
  view: SessionView,
  startId: StreamTabId | null,
  boardId: StreamTabId | null,
  deferred: DeferredRunModels,
): void {
  const seen = new Set<StreamTabId>();
  let id = startId;
  while (id !== null && !seen.has(id)) {
    seen.add(id);
    const current = view.streams.get(id);
    if (!current) return;
    let next = withAggregates(view, current);
    if (id === boardId) next = runModelAt(view, next, deferred);
    if (next !== current) view.streams.set(id, next);
    id = current.parentId;
  }
}

// ---------------------------------------------------------------------------
// Transcript slice
// ---------------------------------------------------------------------------

function upsertRow(transcript: TranscriptView, row: TranscriptRow): void {
  const { rows } = transcript;
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

function rowById(
  transcript: TranscriptView,
  id: string,
): TranscriptRow | undefined {
  const at = indexesOf(transcript).rowIndex.get(id);
  return at === undefined ? undefined : transcript.rows[at];
}

function reconcileCompactionRows(
  transcript: TranscriptView,
  changedIndices: readonly number[],
): void {
  const { compactionState } = indexesOf(transcript);
  for (const blockIndex of changedIndices) {
    const block = compactionState.blocks[blockIndex];
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

type StreamingTextRow = Extract<
  TranscriptRow,
  { kind: 'assistant' | 'thinking' | 'scratchpad' }
>;

function isStreamingTextRow(row: TranscriptRow): row is StreamingTextRow {
  return (
    row.kind === 'assistant' ||
    row.kind === 'thinking' ||
    row.kind === 'scratchpad'
  );
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
  const next = replaceTranscript(transcript, {});
  const indexes = indexesOf(next);
  upsertTaskGroupFromStreamLog(next.taskGroups, indexes.taskGroupIndex, entry);
  const marker = workflowMarkerOf(entry);
  if (marker) {
    indexes.workflowAttemptId = marker.attemptId ?? indexes.workflowAttemptId;
    indexes.plan = marker.kind === 'plan' ? marker.plan : undefined;
  }
  reconcileCompactionRows(
    next,
    applyCompactionActivityEntries(indexes.compactionState, [entry]),
  );
  projectRow(next, entry);
  if (isStreamingEntry(entry)) {
    const row = rowById(next, entry.id);
    const text = entry.text ?? '';
    indexes.streaming.set(entry.id, {
      entry,
      // The projected row already measured the text; a blank entry has none.
      text: row && isStreamingTextRow(row) ? row.text : transcriptText(text),
      end: text.at(-1) ?? '',
      lastChunkIndex: -1,
    });
  } else {
    indexes.streaming.delete(entry.id);
  }
  return next;
}

/** Finalize unmatched compaction starts when the turn settles. */
function withSettledTranscript(
  stream: StreamView,
  finishedAt: number,
): StreamView {
  if (!isTranscriptSettlementPhase(stream.status)) return stream;
  const transcript = replaceTranscript(stream.transcript, {});
  const changed = settleCompactionActivities(
    indexesOf(transcript).compactionState,
    { finishedAt },
  );
  if (changed.length === 0) return stream;
  reconcileCompactionRows(transcript, changed);
  return { ...stream, transcript };
}

/**
 * Apply one live chunk to its streaming row at O(chunk): the row's text is
 * extended, never re-measured from the whole. The embedded-followup flag is
 * the one whole-text scan, and it runs only while a block is open or the
 * chunk could open one. Returns whether the chunk changed anything.
 */
function foldTextChunk(view: SessionView, chunk: TextChunk): boolean {
  const stream = view.streams.get(chunk.streamId);
  if (!stream) return false;
  const indexes = indexesOf(stream.transcript);
  const cursor = indexes.streaming.get(chunk.entryId);
  // A chunk for a row this process has not seen, or one already applied
  // (a resync replays the inflight tail), changes nothing: the next durable
  // entry for the row carries its full text.
  if (!cursor || chunk.chunkIndex <= cursor.lastChunkIndex) return false;
  cursor.text = appendTranscriptText(cursor.text, chunk.text, cursor.end);
  cursor.end = chunk.text.at(-1) ?? cursor.end;
  cursor.lastChunkIndex = chunk.chunkIndex;
  const transcript = replaceTranscript(stream.transcript, {});
  const at = indexes.rowIndex.get(chunk.entryId);
  const row = at === undefined ? undefined : transcript.rows[at];
  if (at !== undefined && row && isStreamingTextRow(row)) {
    const { pendingEmbeddedFollowup: wasPending, ...rest } = row;
    const pending =
      row.kind === 'assistant' && (wasPending || chunk.text.includes('<'))
        ? hasIncompleteEmbeddedSubagentFollowup(cursor.text.full)
        : wasPending;
    transcript.rows[at] = {
      ...rest,
      text: cursor.text,
      ...(pending ? { pendingEmbeddedFollowup: true } : {}),
    };
  } else {
    // The entry's own text was blank and projected no row; the chunk that
    // gives it one projects it once.
    projectRow(transcript, { ...cursor.entry, text: cursor.text.full });
  }
  view.streams.set(stream.id, { ...stream, transcript });
  return true;
}

// ---------------------------------------------------------------------------
// Durable events
// ---------------------------------------------------------------------------

/**
 * Round-keyed merge, mirroring `StreamSnapshotStore`'s field normalizers: an
 * empty round drops the key for files and compile failures (the tab shows no
 * empty round), and overwrites for missing outputs (an empty list clears the
 * round's missing set).
 */
function mergeRounds<T>(
  current: RoundIndexed<T>,
  incoming: RoundIndexed<T>,
  emptyRound: 'drop' | 'keep',
): RoundIndexed<T> {
  const next: RoundIndexed<T> = { ...current };
  for (const key of Object.keys(incoming)) {
    const round = Number(key);
    const files = incoming[round];
    if (emptyRound === 'drop' && files.length === 0) delete next[round];
    else next[round] = files;
  }
  return next;
}

/** A tool-use fact on a stream whose arm cannot hold it is a publisher or
 *  category defect, made loud at the fold's boundary. */
function wrongArm(stream: StreamView, event: DurableEvent): never {
  throw new Error(
    `${event.type} names ${stream.id}, a ${stream.category} stream; the fact belongs to the ${AgentCategory.ToolUse} arm`,
  );
}

/** The event's own arm applied to its stream (topology and session slices
 *  are handled by the caller). */
function applyOwnArm(stream: StreamView, event: DurableEvent): StreamView {
  switch (event.type) {
    case 'run.start': {
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
        {
          ...stream,
          status: event.phase,
          substate: event.substate ?? null,
          runStartedAt: event.runStartedAt ?? null,
          ...(freshRun
            ? { stage: null, conversationProgress: { toolCallCount: 0 } }
            : {}),
        },
        event.timestamp,
      );
    }
    case 'result':
      return withSettledTranscript(
        {
          ...stream,
          status: event.outcome,
          substate: null,
          runStartedAt: null,
        },
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
          utilizationPercent: roundedUtilizationPercent(
            event.inputTokens,
            event.contextWindow,
          ),
        },
      };
    case 'updateTodos':
      return stream.category === AgentCategory.ToolUse
        ? { ...stream, todos: event.todos }
        : wrongArm(stream, event);
    case 'updatePlan':
      return stream.category === AgentCategory.ToolUse
        ? { ...stream, plan: event.plan }
        : wrongArm(stream, event);
    case 'goalStateChanged':
      return stream.category === AgentCategory.ToolUse
        ? { ...stream, goal: event.state }
        : wrongArm(stream, event);
    case 'goalPaused':
      // The pause itself lands as the next `goalStateChanged`; hosts surface
      // the notice from the fact, not from a view field.
      return stream;
    case 'addOutputFiles':
      return stream.category === AgentCategory.Workflow
        ? {
            ...stream,
            files: mergeRounds(stream.files, event.filesByRound, 'drop'),
          }
        : {
            ...stream,
            outputs: mergeRounds(stream.outputs, event.filesByRound, 'drop'),
          };
    case 'updateMissingOutputs':
      return {
        ...stream,
        missingOutputs: mergeRounds(
          stream.missingOutputs,
          event.filesByRound,
          'keep',
        ),
      };
    case 'updateCompileFailures':
      return {
        ...stream,
        compileFailures: mergeRounds(
          stream.compileFailures,
          event.filesByRound,
          'drop',
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
    case 'run.start':
      // The initial snapshot rides the existence fact (PRD 6, item 2); a
      // legacy import carries none and leaves the entry to `approval.policy`.
      if (event.approvalPolicy) {
        view.policy.set(event.streamId, event.approvalPolicy);
      }
      return;
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

/**
 * Move `stream` from `previousParentId` to its current parent. A parent the
 * view has no `run.start` for leaves the stream top-level; `ancestors` keeps
 * the edge by its last known label.
 */
function relink(
  view: SessionView,
  stream: StreamView,
  previousParentId: StreamTabId | null,
): void {
  const previousParent =
    previousParentId === null ? undefined : view.streams.get(previousParentId);
  if (previousParent) {
    view.streams.set(previousParent.id, {
      ...previousParent,
      childIds: withoutId(previousParent.childIds, stream.id),
    });
  }
  const parent =
    stream.parentId === null ? undefined : view.streams.get(stream.parentId);
  if (parent) {
    view.streams.set(parent.id, {
      ...parent,
      childIds: insertOrdered(view, parent.childIds, stream.id),
    });
  }
  const inOrder = view.order.includes(stream.id);
  if (!parent && !inOrder) {
    view.order = insertOrdered(view, view.order, stream.id);
  }
  if (parent && inOrder) view.order = withoutId(view.order, stream.id);
  refreshAncestors(view, stream.id);
}

/** Returns whether the event changed anything. */
function foldDurable(
  view: SessionView,
  event: DurableEvent,
  deferred: DeferredRunModels,
): boolean {
  if (event.streamId === null) {
    // Session-scoped: no stream arm, no per-stream seq.
    applySessionSlices(view, event);
    return true;
  }
  const known = view.streams.get(event.streamId);
  // At-least-once delivery: a seq this stream has already folded is a replay.
  if (known && event.seq <= known.transcript.settledSeq) return false;
  if (event.type === 'removeStream') {
    return foldRemoveStream(view, event.streamId, deferred);
  }
  // Existence: only `run.start` mints a stream. The envelope stamper logs a
  // fact that arrives for a stream the view has no `run.start` for.
  if (!known && event.type !== 'run.start') return false;
  const created = !known;
  const before =
    known ??
    createStream(
      event.streamId,
      (event.type === 'run.start' && event.agentCategory) ||
        AgentCategory.ToolUse,
      event.timestamp,
    );

  applySessionSlices(view, event);
  const own = applyOwnArm(before, event);
  let next: StreamView = {
    ...own,
    ownerId: event.ownerId,
    lastTimestamp: event.timestamp,
    transcript: replaceTranscript(own.transcript, { settledSeq: event.seq }),
  };
  view.streams.set(next.id, next);

  if (created || next.parentId !== before.parentId) {
    relink(view, next, before.parentId);
    walkUp(view, before.parentId, before.parentId, deferred);
  }
  if (next.label !== before.label) {
    for (const childId of next.childIds) refreshAncestors(view, childId);
  }
  next = view.streams.get(next.id)!;
  const aggregated = withAggregates(view, next);
  // The run model's own inputs: the stream's existence and status, and the
  // transcript entries it reads.
  const runInputsMoved =
    created ||
    own.status !== before.status ||
    (event.type === 'legacy.entry' && entryAffectsRunModel(event.entry));
  view.streams.set(
    next.id,
    runInputsMoved ? runModelAt(view, aggregated, deferred) : aggregated,
  );
  walkUp(
    view,
    next.parentId,
    created || childProgressChanged(before, next) ? next.parentId : null,
    deferred,
  );
  return true;
}

function foldRemoveStream(
  view: SessionView,
  streamId: StreamTabId,
  deferred: DeferredRunModels,
): boolean {
  const stream = view.streams.get(streamId);
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
    walkUp(view, parent.id, parent.id, deferred);
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

function foldOwnerLiveness(
  view: SessionView,
  snapshot: OwnerLiveness,
  deferred: DeferredRunModels,
): void {
  view.liveOwners = [...snapshot.owners];
  // Only a stream with a pending request can change group on liveness; the
  // approvals list names them, so no whole-view pass.
  const touched = new Set<StreamTabId>(view.approvals.map((a) => a.streamId));
  for (const streamId of touched) walkUp(view, streamId, null, deferred);
}
