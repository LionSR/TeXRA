/**
 * The one fold (PRD one-fold-three-renderers, G1 and 5.2): `fold(view,
 * input)` turns the durable session events, live text chunks, the local
 * runtime snapshot, and the transcript subscription set into `SessionView`.
 * Every process that shows a session runs it; the transport carries its
 * input, never its output.
 *
 * Pure in the sense that matters: no IO, no clock, no platform, no store
 * reads, and the same input sequence yields the same view. Incremental in
 * the sense the PRD requires: an event recomputes the arm for its stream,
 * walks `parentId` to the root refreshing each ancestor's `childIds`,
 * `rollup`, `approval`, `group`, and `forceExpanded`, then touches `order`
 * only when a top-level stream appeared, moved, or left. O(depth) per
 * event, never a whole-view pass. A text chunk costs the chunk, never the
 * row's text.
 *
 * Three rules govern the event arm before any fact applies (5.2). A listing
 * fact is ordered by commit within its `(aggregate, listing type)` entry in
 * `view.latest` and ignored when it is not above it, whichever read
 * delivered it. A transcript row folds only for an aggregate in the
 * subscription set (its `view.folded` entry), and only when its seq is above
 * that entry, which it then advances. `view.cursor` moves on tail rows
 * alone. Existence: a stream exists iff its `run.start` has folded and its
 * `stream.removed` has not; the tombstone is final and ids are never reused
 * (decision 9), so a fact naming any other stream changes nothing.
 *
 * The run model (`transcript.run`) is derived only when one of its inputs
 * moved: the stream's own `run.start`, a status change, a transcript entry
 * the model reads (a workflow card, a group boundary, a plan marker), or a
 * direct child's progress. Folding a frame defers that derivation to the end
 * of the frame, so a replay of R events derives each touched board once.
 *
 * The accumulator contract that makes this O(depth): `view.streams`,
 * `view.policy`, `view.folded`, `view.latest`, and `view.queuedFollowUps`
 * are indexes reused across folds, a transcript's arrays are appended in
 * place (a copy per entry would make a replay quadratic), and the fold's own
 * indexes over a transcript live in a module-private map keyed by the
 * transcript value. Every `StreamView` value, every `TranscriptView` value,
 * and the `SessionView` envelope are replaced on change and never mutated,
 * so a host that compares those by identity sees exactly what changed. A
 * caller holds the latest view only.
 */
import {
  AgentCategory,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_PHASE,
  STREAM_STATUS,
  STREAMING_TEXT_MESSAGE_TYPES,
  isPlainAgentIdentity,
  listingTypeOf,
  runIdentityDisplayName,
  sumUsageStats,
  type AggregateId,
  type FoldInput,
  type LocalRuntimeState,
  type RoundIndexed,
  type SessionEvent,
  type StreamLogEntry,
  type StreamTabId,
  type TaskGroup,
  type TextChunk,
  type TranscriptSubscription,
  type WorkflowDeclaredPlan,
} from '@shared/schemas';
import {
  compactionActivityRow,
  isSettledRow,
  projectTranscriptRow,
  promotesOnlyOnTypedTerminalState,
  type TranscriptRow,
  type TranscriptRowKind,
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
} from '@shared/streams/streamStatus';
import {
  streamHeldMessage,
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
type RunStartEvent = Extract<DurableEvent, { type: 'run.start' }>;

/** Workflow-script stream ids whose run model a batch derives at its end. */
type DeferredRunModels = Set<StreamTabId> | null;

/** Canonical dashboard rows a workflow-script run model reads. */
const WORKFLOW_DASHBOARD_KINDS = new Set<TranscriptRowKind>([
  'compactionActivity',
  'phase',
  'workflowTask',
]);

/** Residency cap on the dashboard rows one run model folds: a long workflow
 *  keeps its newest cards, never an unbounded history (PRD 5.2). */
const MAX_RUN_MODEL_DASHBOARD_ROWS = 2_000;

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
    if (stream) setStream(next, withRunModel(next, stream));
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
  switch (input._tag) {
    case 'event': {
      if (input.read === 'all' && input.event.commit > next.cursor) {
        next.cursor = input.event.commit;
      }
      return foldDurable(next, input.event, deferred) ||
        next.cursor !== view.cursor
        ? next
        : view;
    }
    case 'chunk':
      return foldTextChunk(next, input) ? next : view;
    case 'local':
      foldLocal(next, input.local, deferred);
      return next;
    case 'subscriptions':
      foldSubscriptions(next, input.set, deferred);
      return next;
    case 'replay.complete':
      // The marker carries no fact (PRD 5.2); the publish gate reads it from
      // the input beside the view, never from the view.
      return view;
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

function emptyTranscript(settledSeq = 0): TranscriptView {
  const compactionState = createCompactionActivityProjection();
  const transcript: TranscriptView = {
    rows: [],
    taskGroups: [],
    compaction: compactionState.blocks,
    settledSeq,
    settledRows: 0,
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

/**
 * A stream in its initial shape, minted by its `run.start` alone. A run with
 * no category (a process stream, a legacy import) takes the tool-use arm, as
 * roster provisioning does today.
 */
function createStream(event: RunStartEvent): StreamView {
  const id = event.aggregateId as StreamTabId;
  const status = STREAM_STATUS.READY;
  const identity = event.identity ?? null;
  const common = {
    id,
    executionId: event.executionId,
    identity,
    isRemote: event.isRemote ?? false,
    ownerId: event.ownerId,
    label: identity
      ? runIdentityDisplayName(identity)
      : streamIdDisplayName(id),
    description: null,
    model: null,
    modelLabel: null,
    command: null,
    inputFiles: [],
    worktree: event.worktree ?? null,
    status,
    substate: null,
    statusDetail: null,
    ...streamStatusCopy(status),
    createdAt: event.commit,
    runStartedAt: null,
    lastTimestamp: event.at,
    conversationProgress: { toolCallCount: 0 },
    stage: null,
    followUpSupport: event.userFollowUpSupport ?? ('unsupported' as const),
    context: null,
    parentId: event.parentStreamId ?? null,
    ancestors: [],
    childIds: [],
    rollup: { total: 0, running: 0, finished: 0 },
    approval: 'none' as const,
    readOnly: false,
    forceExpanded: false,
    group: 'recent' as const,
    usage: {},
    thinkingActive: false,
    compactingActive: false,
    latestLine: null,
    transcript: emptyTranscript(),
  };
  return event.agentCategory === AgentCategory.Workflow
    ? {
        ...common,
        category: AgentCategory.Workflow,
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

/**
 * Land a stream value in the index and keep the paper-level rollup (5.1)
 * current from the group it left and the group it entered. Every write to
 * `view.streams` goes through here; `dropStream` is the one removal.
 */
function setStream(view: SessionView, stream: StreamView): void {
  const previous = view.streams.get(stream.id);
  view.streams.set(stream.id, stream);
  if (previous?.group !== stream.group) {
    countGroups(view, previous?.group, stream.group);
  }
}

function dropStream(view: SessionView, stream: StreamView): void {
  view.streams.delete(stream.id);
  countGroups(view, stream.group, undefined);
}

function countGroups(
  view: SessionView,
  left: StreamView['group'] | undefined,
  entered: StreamView['group'] | undefined,
): void {
  const rollup = { ...view.rollup };
  if (left === 'running' || left === 'waiting' || left === 'interrupted') {
    rollup[left] -= 1;
  }
  if (
    entered === 'running' ||
    entered === 'waiting' ||
    entered === 'interrupted'
  ) {
    rollup[entered] += 1;
  }
  view.rollup = rollup;
}

// ---------------------------------------------------------------------------
// Ordering and topology
// ---------------------------------------------------------------------------

function orderingKey(stream: StreamView): {
  name: string;
  creationTimestamp: number;
} {
  return { name: stream.id, creationTimestamp: stream.createdAt };
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

/** Root first. A parent edge always names a stream the view holds: the fold
 *  re-roots a child whose parent it lacks (5.2, `ancestors`). */
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
    if (!parent) break;
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
  if (!unchanged) setStream(view, { ...stream, ancestors });
  for (const childId of stream.childIds) refreshAncestors(view, childId);
}

// ---------------------------------------------------------------------------
// Derived per-stream facts
// ---------------------------------------------------------------------------

/** Whether somebody holds the stream's run: its owner is this process or a
 *  process whose lease this one may not touch (5.2, `group`). */
function ownerHeld(local: LocalRuntimeState, stream: StreamView): boolean {
  return (
    stream.ownerId !== null &&
    (local.self.includes(stream.ownerId) ||
      local.heldBy.includes(stream.ownerId))
  );
}

/**
 * `group`, `approval`, `readOnly`, `forceExpanded`, `rollup`, and the status
 * copy from the stream's own facts, the local snapshot, and its children
 * (5.2). Interrupted is owner loss: an in-flight stream nobody holds, whether
 * or not an approval is pending. Waiting needs a held owner: without one the
 * same pending request reads as interrupted, never waiting, because nothing
 * is listening for the answer; the durable phase and the listed approval
 * stay, so a resume can re-ask.
 */
function withAggregates(view: SessionView, stream: StreamView): StreamView {
  const { local } = view;
  const held = ownerHeld(local, stream);
  const pendingOwn = view.approvals.some((a) => a.streamId === stream.id);
  const interrupted = isInFlightPhase(stream.status) && !held;
  const waiting = pendingOwn && held;
  const heldElsewhere =
    stream.ownerId !== null &&
    local.heldBy.includes(stream.ownerId) &&
    !local.self.includes(stream.ownerId);
  const unreadable = local.unreadable.find((u) => u.streamId === stream.id);
  const rollup = { total: 0, running: 0, finished: 0 };
  let descendantWaiting = false;
  let descendantNeedsUser = false;
  for (const childId of stream.childIds) {
    const child = view.streams.get(childId);
    if (!child) continue;
    rollup.total += 1 + child.rollup.total;
    rollup.running +=
      (isInFlightPhase(child.status) ? 1 : 0) + child.rollup.running;
    rollup.finished +=
      (isTerminalOutcomePhase(child.status) ? 1 : 0) + child.rollup.finished;
    if (child.approval !== 'none') descendantWaiting = true;
    if (child.forceExpanded) descendantNeedsUser = true;
  }
  let group: StreamView['group'] = 'recent';
  if (interrupted) group = 'interrupted';
  else if (waiting) group = 'waiting';
  else if (isInFlightPhase(stream.status)) group = 'running';
  let approval: StreamView['approval'] = 'none';
  if (waiting) approval = 'own';
  else if (descendantWaiting) approval = 'descendant';
  const copy = streamStatusCopy(stream.status, {
    substate: stream.substate ?? undefined,
    interrupted,
  });
  const readOnly = heldElsewhere || unreadable !== undefined;
  const forceExpanded = waiting || interrupted || descendantNeedsUser;
  let statusDetail: string | null = unreadable?.detail ?? null;
  if (statusDetail === null && interrupted) {
    statusDetail = streamInterruptedMessage();
  } else if (statusDetail === null && heldElsewhere) {
    statusDetail = streamHeldMessage(stream.ownerId as string);
  }
  if (
    stream.group === group &&
    stream.approval === approval &&
    stream.readOnly === readOnly &&
    stream.forceExpanded === forceExpanded &&
    stream.rollup.total === rollup.total &&
    stream.rollup.running === rollup.running &&
    stream.rollup.finished === rollup.finished &&
    stream.statusLabel === copy.statusLabel &&
    stream.tone === copy.tone &&
    stream.statusDetail === statusDetail
  ) {
    return stream;
  }
  return {
    ...stream,
    group,
    approval,
    readOnly,
    forceExpanded,
    rollup,
    ...copy,
    statusDetail,
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

/** Whether a transcript entry is one the run model reads: a group boundary
 *  (phases), a workflow card, or a plan marker. */
function entryAffectsRunModel(entry: StreamLogEntry): boolean {
  return (
    entry.type !== STREAM_LOG_ENTRY_TYPES.LOG ||
    entry.messageType === MESSAGE_TYPES.WORKFLOW_TASK ||
    workflowMarkerOf(entry) !== undefined
  );
}

/**
 * The run model's residency (PRD 5.2, section 4 of the build note): the
 * newest dashboard rows up to the cap, and the phase groups those rows still
 * name. A phase whose every card fell off the cap is not shown.
 */
function runModelInputs(transcript: TranscriptView): {
  rows: TranscriptRow[];
  taskGroups: TaskGroup[];
} {
  const dashboard = transcript.rows.filter((row) =>
    WORKFLOW_DASHBOARD_KINDS.has(row.kind),
  );
  const rows =
    dashboard.length > MAX_RUN_MODEL_DASHBOARD_ROWS
      ? dashboard.slice(-MAX_RUN_MODEL_DASHBOARD_ROWS)
      : dashboard;
  if (rows.length === dashboard.length) {
    return { rows, taskGroups: transcript.taskGroups };
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
  };
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
    ...runModelInputs(transcript),
    workflowAttemptId: indexes.workflowAttemptId,
    plan: indexes.plan,
    streamPhase: stream.status,
    // A terminal outcome with no owner left to settle its cards.
    runDurablyFinal:
      isTerminalOutcomePhase(stream.status) && !ownerHeld(view.local, stream),
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
    if (next !== current) setStream(view, next);
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

/**
 * Whether a stream's run, round, and session headings go to the task-group
 * surface rather than the rows (keyed on the identity, never the id format):
 * every workflow run and every plain agent run. The one exception is a
 * full-log child that is not a workflow run, a detached process or an
 * external-CLI session, whose verbatim log is the point of opening it.
 */
function lifecycleToTaskGroups(stream: StreamView): boolean {
  return (
    stream.category === AgentCategory.Workflow ||
    stream.identity === null ||
    isPlainAgentIdentity(stream.identity)
  );
}

function projectRow(
  transcript: TranscriptView,
  entry: StreamLogEntry,
  projectLifecycleToTaskGroups: boolean,
): void {
  const row = projectTranscriptRow(entry, {
    previousRow: rowById(transcript, entry.id),
    projectLifecycleToTaskGroups,
  });
  if (row) upsertRow(transcript, row);
}

/** Fold one transcript row into the slice: the row, task-group, compaction,
 *  and run-marker reducers, each called unchanged. */
function applyEntry(stream: StreamView, entry: StreamLogEntry): TranscriptView {
  const next = replaceTranscript(stream.transcript, {});
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
  projectRow(next, entry, lifecycleToTaskGroups(stream));
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

// ---------------------------------------------------------------------------
// Transcript-derived stream facts (G4: derived in the fold, never by a host)
// ---------------------------------------------------------------------------

/** The headline a status line shows for a row: its own text, untrimmed and
 *  unsanitized; a host sanitizes for its surface at paint. */
function rowHeadline(row: TranscriptRow): string {
  switch (row.kind) {
    case 'assistant':
    case 'log':
      return row.text.full;
    case 'user':
    case 'error':
    case 'progressStatus':
      return row.summary.full;
    case 'workflowTask':
      return row.line;
    case 'phase':
      return row.heading;
    case 'thinking':
      return 'Thinking';
    case 'scratchpad':
      return 'Scratchpad';
    case 'webSearch':
    case 'webFetch':
    case 'statistics':
    case 'contextManagement':
    case 'compactionActivity':
      return row.label;
    case 'fileList':
    case 'missingOutputs':
      return row.summary;
    case 'latexdiff':
      return `Latexdiff results (${row.entries.length})`;
    case 'tool':
      return '';
  }
}

function nonEmpty(text: string | undefined): string | undefined {
  return text !== undefined && text.trim().length > 0 ? text : undefined;
}

/** A workflow run's newest operational summary: what its tool, phase, card,
 *  error, or plain log row last said. */
function workflowOperationalLatestLine(
  rows: readonly TranscriptRow[],
): string | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row.kind === 'tool') {
      const line =
        nonEmpty(row.toolUse.headerSummary) ?? nonEmpty(row.model.headerLabel);
      if (line) return line;
      continue;
    }
    if (row.kind === 'phase') {
      const line = nonEmpty(row.phaseLabel);
      if (line) return line;
      continue;
    }
    if (
      row.kind === 'error' ||
      row.kind === 'workflowTask' ||
      ((row.kind === 'assistant' || row.kind === 'log') &&
        row.messageType === MESSAGE_TYPES.DEFAULT)
    ) {
      const line = nonEmpty(rowHeadline(row));
      if (line) return line;
    }
  }
  return undefined;
}

/** Any other run's newest user instruction or settled model reply. */
function latestConversationLine(
  rows: readonly TranscriptRow[],
  settledRows: number,
): string | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    const headline = rowHeadline(row);
    if (headline.trim().length === 0) continue;
    if (row.kind === 'user') return headline;
    const response =
      (row.kind === 'assistant' || row.kind === 'log') &&
      row.messageType === MESSAGE_TYPES.MODEL_RESPONSE;
    if (
      response &&
      (index < settledRows || isSettledRow(row, index < rows.length - 1))
    ) {
      return headline;
    }
  }
  return undefined;
}

/**
 * Advance the contiguous leading prefix of settled rows (5.2, `settledRows`):
 * an append-only scrollback prints rows in order, so a row is settled for
 * printing only once every row before it is. Only the tail past the previous
 * frontier is walked. A final stream settles every open row except the two
 * kinds whose state bridge cleanup can still replace (a compaction block, a
 * workflow card).
 */
function advanceSettledRows(
  rows: readonly TranscriptRow[],
  start: number,
  streamFinal: boolean,
): number {
  let index = Math.min(start, rows.length);
  while (index < rows.length) {
    const row = rows[index];
    if (!isSettledRow(row, index < rows.length - 1)) {
      if (promotesOnlyOnTypedTerminalState(row) || !streamFinal) break;
    }
    index += 1;
  }
  return index;
}

/** The transcript-derived fields of a stream, after its rows or its
 *  settlement moved: `settledRows`, `thinkingActive`, `compactingActive`,
 *  and `latestLine`. */
function withTranscriptFacts(stream: StreamView): StreamView {
  const { transcript } = stream;
  const streamFinal = isTranscriptSettlementPhase(stream.status);
  const settledRows = advanceSettledRows(
    transcript.rows,
    transcript.settledRows,
    streamFinal,
  );
  const lastThinking = transcript.rows.findLast(
    (row) => row.kind === 'thinking',
  );
  const thinkingActive =
    lastThinking?.kind === 'thinking' && lastThinking.streaming;
  const compactingActive = transcript.compaction.some(
    (block) => block.status === 'running',
  );
  const latestLine =
    (stream.category === AgentCategory.Workflow
      ? workflowOperationalLatestLine(transcript.rows)
      : latestConversationLine(transcript.rows, settledRows)) ??
    stream.latestLine;
  if (
    settledRows === transcript.settledRows &&
    thinkingActive === stream.thinkingActive &&
    compactingActive === stream.compactingActive &&
    latestLine === stream.latestLine
  ) {
    return stream;
  }
  return {
    ...stream,
    thinkingActive,
    compactingActive,
    latestLine,
    transcript:
      settledRows === transcript.settledRows
        ? transcript
        : replaceTranscript(transcript, { settledRows }),
  };
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
    projectRow(
      transcript,
      { ...cursor.entry, text: cursor.text.full },
      lifecycleToTaskGroups(stream),
    );
  }
  setStream(view, { ...stream, transcript });
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
    case 'run.start':
      // Existence cannot become more true (5.2, "Duplicates"): a second
      // start for a stream the view holds is a no-op.
      return stream;
    case 'run.activate':
      // Ownership moves with the envelope the caller stamps; the activation
      // metadata repeats the launch facts the stream already carries.
      return stream;
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
        inputFiles: event.config.inputFiles ?? stream.inputFiles,
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
        event.at,
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
        event.at,
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
        context: {
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
    case 'setParentStream':
      return event.parentStreamId === stream.parentId
        ? stream
        : { ...stream, parentId: event.parentStreamId };
    case 'updateStreamDescription':
      return { ...stream, description: event.description };
    case 'transcript.entry':
      return { ...stream, transcript: applyEntry(stream, event.entry) };
    case 'approval.requested':
    case 'approval.resolved':
    case 'approval.policy':
    case 'inquiryThreadUpdated':
    case 'updateQueuedFollowUps':
    case 'stream.removed':
      return stream;
  }
}

/** Session-level slices, applied before the stream arm so the arm's
 *  aggregates see them. */
function applySessionSlices(
  view: SessionView,
  streamId: StreamTabId | null,
  event: DurableEvent,
): void {
  switch (event.type) {
    case 'run.start':
      // The initial snapshot rides the existence fact (PRD 6, item 2); a
      // legacy import carries none and leaves the entry to `approval.policy`.
      if (event.approvalPolicy && streamId !== null) {
        view.policy.set(streamId, event.approvalPolicy);
      }
      return;
    case 'approval.requested':
      // A set keyed by request id (5.2): a replayed request is one entry.
      if (streamId === null) return;
      if (view.approvals.some((a) => a.requestId === event.requestId)) return;
      view.approvals = [
        ...view.approvals,
        {
          streamId,
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
      if (streamId !== null) view.policy.set(streamId, event.snapshot);
      return;
    case 'inquiryThreadUpdated': {
      const {
        type: _type,
        aggregateId: _aggregateId,
        seq: _seq,
        commit: _commit,
        ownerId: _ownerId,
        at: _at,
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
      if (streamId !== null) view.queuedFollowUps.set(streamId, event.messages);
      return;
    default:
      return;
  }
}

/**
 * Move `stream` from `previousParentId` to its current parent. A parent the
 * view has no `run.start` for re-roots the stream: top-level, no ancestors
 * (5.2, `ancestors`).
 */
function relink(
  view: SessionView,
  stream: StreamView,
  previousParentId: StreamTabId | null,
): void {
  const previousParent =
    previousParentId === null ? undefined : view.streams.get(previousParentId);
  if (previousParent) {
    setStream(view, {
      ...previousParent,
      childIds: withoutId(previousParent.childIds, stream.id),
    });
  }
  const parent =
    stream.parentId === null ? undefined : view.streams.get(stream.parentId);
  if (!parent && stream.parentId !== null) {
    setStream(view, { ...stream, parentId: null });
  }
  if (parent) {
    setStream(view, {
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

/** The stream a durable event names: its aggregate, except for the thread
 *  aggregate of an inquiry (5.1). */
function streamOf(event: DurableEvent): StreamTabId | null {
  return event.type === 'inquiryThreadUpdated'
    ? null
    : (event.aggregateId as StreamTabId);
}

/** Returns whether the event changed anything. */
function foldDurable(
  view: SessionView,
  event: DurableEvent,
  deferred: DeferredRunModels,
): boolean {
  if (event.type === 'transcript.entry') return foldTranscriptRow(view, event);
  // Listing facts are ordered by commit per (aggregate, listing type),
  // whichever read delivered them (5.2, "Duplicates").
  const listingKey = `${event.aggregateId}/${listingTypeOf(event)}`;
  const latest = view.latest.get(listingKey);
  if (latest !== undefined && event.commit <= latest) return false;
  view.latest.set(listingKey, event.commit);

  const streamId = streamOf(event);
  if (streamId === null) {
    applySessionSlices(view, null, event);
    return true;
  }
  if (event.type === 'stream.removed') {
    return foldStreamRemoved(view, streamId, deferred);
  }
  const known = view.streams.get(streamId);
  // Existence: only `run.start` mints a stream, once. A fact for a stream
  // the view has no `run.start` for changes nothing (its publisher logs it).
  if (!known && event.type !== 'run.start') return false;
  const created = !known;
  const before = known ?? createStream(event as RunStartEvent);

  applySessionSlices(view, streamId, event);
  const own = applyOwnArm(before, event);
  let next: StreamView = {
    ...own,
    ownerId: event.ownerId,
    lastTimestamp: event.at,
    transcript: replaceTranscript(own.transcript, {
      settledSeq: Math.max(own.transcript.settledSeq, event.commit),
    }),
  };
  setStream(view, next);

  if (created || next.parentId !== before.parentId) {
    relink(view, next, created ? null : before.parentId);
    if (!created) walkUp(view, before.parentId, before.parentId, deferred);
  }
  if (next.label !== before.label) {
    for (const childId of next.childIds) refreshAncestors(view, childId);
  }
  next = view.streams.get(next.id)!;
  const aggregated =
    own.status !== before.status
      ? withAggregates(view, withTranscriptFacts(next))
      : withAggregates(view, next);
  // The run model's own inputs: the stream's existence and status.
  const runInputsMoved = created || own.status !== before.status;
  setStream(
    view,
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

/**
 * The transcript tier (5.2, "Residency"): a row folds only for an aggregate
 * in the subscription set and only above the seq the view has retained for
 * it, which it then advances. A dropped row never touches `folded`.
 */
function foldTranscriptRow(
  view: SessionView,
  event: Extract<DurableEvent, { type: 'transcript.entry' }>,
): boolean {
  const retained = view.folded.get(event.aggregateId);
  if (retained === undefined || event.seq <= retained) return false;
  const stream = view.streams.get(event.aggregateId as StreamTabId);
  if (!stream) return false;
  view.folded.set(event.aggregateId, event.seq);
  const withEntry: StreamView = {
    ...stream,
    lastTimestamp: event.at,
    transcript: replaceTranscript(applyEntry(stream, event.entry), {
      settledSeq: Math.max(stream.transcript.settledSeq, event.commit),
    }),
  };
  const next = withTranscriptFacts(withEntry);
  setStream(view, next);
  if (entryAffectsRunModel(event.entry)) {
    setStream(view, runModelAt(view, next, null));
  }
  return true;
}

/** Whether `stream` is the stream aggregate or the execution aggregate named
 *  by `aggregateId`: a transcript spans both (5.1). */
function isAggregateOf(stream: StreamView, aggregateId: AggregateId): boolean {
  return stream.id === aggregateId || stream.executionId === aggregateId;
}

/**
 * The tombstone (5.2, "Existence" and "Durable text wins"): final, clears
 * every session-level entry keyed by the stream, re-roots its children, and
 * ends its transcript tier.
 */
function foldStreamRemoved(
  view: SessionView,
  streamId: StreamTabId,
  deferred: DeferredRunModels,
): boolean {
  const stream = view.streams.get(streamId);
  if (!stream) return false;
  dropStream(view, stream);
  view.policy.delete(stream.id);
  view.queuedFollowUps.delete(stream.id);
  view.folded.delete(stream.id);
  view.folded.delete(stream.executionId);
  for (const key of [...view.latest.keys()]) {
    if (key.startsWith(`${stream.id}/`)) view.latest.delete(key);
  }
  if (view.approvals.some((a) => a.streamId === stream.id)) {
    view.approvals = view.approvals.filter((a) => a.streamId !== stream.id);
  }
  if (view.inquiries.some((i) => i.parentStreamId === stream.id)) {
    view.inquiries = view.inquiries.filter(
      (i) => i.parentStreamId !== stream.id,
    );
  }
  view.order = withoutId(view.order, stream.id);
  const parent =
    stream.parentId === null ? undefined : view.streams.get(stream.parentId);
  if (parent) {
    setStream(view, {
      ...parent,
      childIds: withoutId(parent.childIds, stream.id),
    });
    walkUp(view, parent.id, parent.id, deferred);
  }
  // A child whose parent is gone is top-level: no dangling edge, no
  // ancestors (5.2, `ancestors`).
  for (const childId of stream.childIds) {
    const child = view.streams.get(childId);
    if (!child) continue;
    setStream(view, { ...child, parentId: null });
    view.order = insertOrdered(view, view.order, childId);
    refreshAncestors(view, childId);
  }
  return true;
}

/**
 * The local snapshot names the streams whose owner entered or left the held
 * set and those entering or leaving `unreadable` (5.2, "Incremental"), so an
 * owner exiting recomputes exactly the streams it owned, never the view.
 */
function foldLocal(
  view: SessionView,
  local: LocalRuntimeState,
  deferred: DeferredRunModels,
): void {
  const previous = view.local;
  view.local = local;
  const heldBefore = new Set([...previous.self, ...previous.heldBy]);
  const heldAfter = new Set([...local.self, ...local.heldBy]);
  const changedOwners = new Set<string>();
  for (const owner of heldBefore) {
    if (!heldAfter.has(owner)) changedOwners.add(owner);
  }
  for (const owner of heldAfter) {
    if (!heldBefore.has(owner)) changedOwners.add(owner);
  }
  // `self` and `heldBy` are separate only so `readOnly` can ask who holds:
  // an owner moving between them changes that answer.
  for (const owner of local.heldBy) {
    if (previous.self.includes(owner) !== local.self.includes(owner)) {
      changedOwners.add(owner);
    }
  }
  const touched = new Set<StreamTabId>();
  for (const stream of view.streams.values()) {
    if (stream.ownerId !== null && changedOwners.has(stream.ownerId)) {
      touched.add(stream.id);
    }
  }
  const unreadableBefore = new Map(
    previous.unreadable.map((u) => [u.streamId, u.detail]),
  );
  const unreadableAfter = new Map(
    local.unreadable.map((u) => [u.streamId, u.detail]),
  );
  for (const [streamId, detail] of unreadableBefore) {
    if (unreadableAfter.get(streamId) !== detail) touched.add(streamId);
  }
  for (const [streamId, detail] of unreadableAfter) {
    if (unreadableBefore.get(streamId) !== detail) touched.add(streamId);
  }
  for (const streamId of touched) walkUp(view, streamId, streamId, deferred);
}

/**
 * The subscription set (5.2, "Residency"): an aggregate entering it gets its
 * `folded` entry at the seq the subscription names; one leaving it loses its
 * transcript tier (rows, task groups, compaction, run model, in-flight text)
 * and its entry, keeping every listing fact.
 */
function foldSubscriptions(
  view: SessionView,
  set: readonly TranscriptSubscription[],
  deferred: DeferredRunModels,
): void {
  const subscribed = new Map(set.map((s) => [s.id, s.fromSeq]));
  for (const [id, fromSeq] of subscribed) {
    if (!view.folded.has(id)) view.folded.set(id, fromSeq);
  }
  for (const id of [...view.folded.keys()]) {
    if (subscribed.has(id)) continue;
    view.folded.delete(id);
    for (const stream of view.streams.values()) {
      if (!isAggregateOf(stream, id)) continue;
      const evicted = withTranscriptFacts({
        ...stream,
        transcript: emptyTranscript(stream.transcript.settledSeq),
      });
      setStream(view, runModelAt(view, evicted, deferred));
      break;
    }
  }
}
