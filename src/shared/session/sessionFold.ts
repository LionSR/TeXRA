/**
 * The one fold (PRD one-fold-three-renderers, G1 and 5.2): `fold(view,
 * input)` turns the durable session events, live text chunks, the local
 * runtime snapshot, and the transcript subscription set into `SessionView`.
 * Every process that shows a session runs it; the transport carries its
 * input, never its output.
 *
 * Pure in the sense that matters: no IO, no clock, no platform, no store
 * reads, and the same input sequence yields the same view. Incremental in
 * the sense the PRD requires: an event recomputes the arm for its run,
 * walks `parentId` to the root refreshing each ancestor's `childIds`,
 * `rollup`, `approval`, `group`, and `forceExpanded`, then touches `order`
 * only when a top-level run appeared, moved, or left. O(depth) per
 * event, never a whole-view pass. A text chunk costs the chunk, never the
 * row's text.
 *
 * Three rules govern the event arm before any fact applies (5.2). A listing
 * fact is ordered by commit within its `(aggregate, listing type)` entry in
 * the session's `latest` index and ignored when it is not above it,
 * whichever read delivered it. A transcript row folds only for an aggregate
 * in the subscription set (its `view.folded` entry), and only when its seq
 * is above that entry, which it then advances. `view.cursor` moves on tail rows
 * alone. Existence: a run exists iff its `run.start` has folded and its
 * `run.removed` has not; the two share one `latest` entry, so the
 * tombstone is final under every read, ids are never reused (decision 9),
 * and a fact naming any other run changes nothing. Listing hydration is
 * authoritative (7.2): at the replay marker every run no listing row of
 * that sequence named is removed the way a tombstone removes it.
 *
 * The run model (`transcript.run`) is derived only when one of its inputs
 * moved: the run's own `run.start`, a status change, a transcript entry
 * the model reads (a workflow card, a group boundary, a plan marker), or a
 * direct child's progress. Folding a frame defers that derivation to the end
 * of the frame, so a replay of R events derives each touched board once.
 *
 * The publication contract (decision D5): every view `fold` returns is
 * immutable, and untouched branches are shared by reference between levels.
 * `view.runs`, `view.policy`, `view.folded`, `view.queuedFollowUps`, and
 * a transcript's `rows` and `taskGroups` are copied at most once per `fold`
 * call, by the write that touches them (`writableMap`,
 * `writableTranscriptArray`), and never written after the call returns.
 * The copy belongs to the write, not to the input: an entry that projects no
 * row, one that lands no task group, and a delete of a key its map never
 * held all leave those branches the objects the previous level published.
 * Every `RunView` value, every `TranscriptView` value, and the
 * `SessionView` envelope are replaced on change and never mutated. A host
 * that compares any of these by identity sees exactly what changed, and an
 * older view is stable to read for as long as it is held. It is not a fold
 * input: the fold's own indexes live in module-private maps keyed by the
 * value they index, per transcript (row and group positions, the measured
 * live text, the newest thinking row) and per view (the current claims, the
 * newest commit per listing entry, the live text per row, the local
 * snapshot, runs by owner, the runs whose lifecycle ended, the
 * aggregates the listing named), and those are single-owner, advancing with
 * the latest level only. The invariant the copy rests on: an arm that writes
 * a container reports `changed`, so `foldWith` publishes the envelope
 * holding the copy; a write followed by "no change" would be dropped, not
 * shared.
 */

import {
  aggregateTarget,
  nonEmptyRounds,
  aggregateId as qualifyAggregateId,
  AgentCategory,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  RUN_PHASE,
  RUN_LIFECYCLE_READY,
  STREAMING_TEXT_MESSAGE_TYPES,
  isPlainAgentIdentity,
  listingTypeOf,
  isTranscriptEvent,
  ownerPid,
  runIdentityDisplayName,
  emptyUsageStats,
  sumUsageStats,
  type AggregateId,
  type FoldInput,
  type ExistenceReconciliation,
  type LocalRuntimeState,
  type RoundIndexed,
  type DisplaySessionEvent,
  type StreamLogEntry,
  type RunId,
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
} from '@shared/runs/compactionActivityProjection';
import { roundedUtilizationPercent } from '@shared/runs/contextUtilization';
import { runStageFromStageStart } from '@shared/runs/stage';
import {
  compareByNewestCreationTime,
  compareBySeqNo,
} from '@shared/runs/runOrdering';
import {
  isInFlightPhase,
  isTerminalOutcomePhase,
  isTranscriptSettlementPhase,
} from '@shared/runs/runStatus';
import {
  runHeldMessage,
  runInterruptedMessage,
  runStatusCopy,
} from '@shared/runs/runStatusDisplay';
import {
  isTaskGroupLifecycleEntry,
  upsertTaskGroupFromStreamLog,
} from '@shared/runs/taskGroupProjection';
import {
  workflowMarkerOf,
  workflowRunModel,
  type ChildRunProgress,
} from '@shared/runs/workflowRunModel';
import { isObject } from '@utils/core';
import { createTranscriptFold } from './traceFold';
import { StreamLog } from './traceEntries';

import type { SessionView, RunView, TranscriptView } from './sessionView';

type RunStartEvent = Extract<DisplaySessionEvent, { type: 'run.start' }>;
type TranscriptEntryEvent = Extract<
  DisplaySessionEvent,
  { type: 'transcript.entry' }
>;

/** Workflow-script run ids whose run model a batch derives at its end. */
type DeferredRunModels = Set<RunId> | null;

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
  // One call publishes one level: nothing this call did not copy is written.
  owned = new WeakSet();
  if (!Array.isArray(input)) return foldWith(view, input as FoldInput, null);
  const deferred = new Set<RunId>();
  let next = view;
  for (const each of input as readonly FoldInput[]) {
    next = foldWith(next, each, deferred);
  }
  for (const runId of deferred) {
    const run = next.runs.get(runId);
    if (run) setRun(next, withRunModel(next, run));
  }
  return next;
}

function foldWith(
  view: SessionView,
  input: FoldInput,
  deferred: DeferredRunModels,
): SessionView {
  // The envelope is replaced, never mutated: work on a copy whose containers
  // are shared with the previous value until this call first writes one.
  const next: SessionView = { ...view };
  switch (input._tag) {
    case 'event': {
      if (input.read === 'listing') {
        sessionIndexesOf(next).listed.add(input.event.aggregateId);
      }
      return foldDurable(next, input.event, deferred, input.read) ? next : view;
    }
    case 'chunk':
      return foldTextChunk(next, input) ? next : view;
    case 'local':
      foldLocal(next, input.local, deferred);
      return next;
    case 'subscriptions':
      foldSubscriptions(next, input.set, deferred);
      return next;
    case 'drained':
      reconcileExistence(next, input.existence, deferred);
      next.cursor = input.cursor;
      return next;
    case 'replay.complete': {
      // The input reader releases the completed replay as one batch (7.2).
      // Its marker closes the listing ahead of it: a run no listing row
      // of this sequence named is gone,
      // tombstone and all, because retention pruned it while this surface
      // was away and no later read can deliver the deletion.
      const { listed } = sessionIndexesOf(next);
      for (const id of [...next.runs.keys()]) {
        if (!listed.has(qualifyAggregateId('run', id)))
          foldRunRemoved(next, id, deferred);
      }
      listed.clear();
      reconcileExistence(next, input.existence, deferred);
      return next;
    }
  }
}

/** Current sequence-row claims supersede historical writers and captured liveness inputs. */
function reconcileExistence(
  view: SessionView,
  existence: ExistenceReconciliation,
  deferred: DeferredRunModels,
): void {
  const { claims } = sessionIndexesOf(view);
  for (const { aggregateId, ownerId } of existence.claims) {
    claims.set(aggregateId, ownerId);
    const target = aggregateTarget(aggregateId);
    if (target.kind !== 'run') continue;
    const run = view.runs.get(target.id);
    if (!run || run.ownerId === ownerId) continue;
    setRun(view, { ...run, ownerId });
    walkUp(view, run.id, run.id, deferred);
  }
  for (const id of existence.removedAggregateIds) {
    claims.delete(id);
    if (view.folded.has(id)) writableMap(view, 'folded').delete(id);
    const target = aggregateTarget(id);
    if (target.kind === 'run') foldRunRemoved(view, target.id, deferred);
    if (
      target.kind === 'inquiry' &&
      view.inquiries.some((inquiry) => inquiry.threadId === target.id)
    ) {
      view.inquiries = view.inquiries.filter(
        (inquiry) => inquiry.threadId !== target.id,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Session indexes (fold-owned, never on the view)
// ---------------------------------------------------------------------------

interface SessionIndexes {
  /** The aggregates the listing named since the previous marker (7.2). */
  readonly listed: Set<AggregateId>;
  /** Runs whose `run.end` row has folded: nothing in the owning
   *  process can still write for them. */
  readonly ended: Set<RunId>;
  /** Runs by their current claimant, so a local snapshot
   *  recomputes exactly the runs a changed owner holds. */
  readonly byOwner: Map<string, Set<RunId>>;
  /** Current sequence-row claims for the checked resident scope. */
  readonly claims: Map<AggregateId, string | null>;
  /** One entry per `${aggregate}/${listing type}`: the commit of the latest
   *  listing fact folded for it, so a replayed older one is ignored. The
   *  lifecycle entry outlives its run: it is what keeps a tombstone
   *  final when a read replays the `run.start` beneath it. */
  readonly latest: Map<string, number>;
  /** Live text per `${run}/${row}`, beside the rows rather than inside
   *  them: a chunk can reach the fold before its row (5.2). A row paints
   *  its durable text joined with this entry; the entry goes when the row
   *  finalizes, the run ends, the run is removed, or its transcript
   *  tier is evicted. */
  readonly inflight: Map<string, string>;
  /** This process's local truth, the snapshot the next one diffs against:
   *  a fold input, never durable. */
  local: LocalRuntimeState;
}

/** Keyed by the run index; a copied index inherits its predecessor's
 *  entry, so every level of one session resolves the same indexes. */
const SESSION_INDEXES = new WeakMap<SessionView['runs'], SessionIndexes>();

function sessionIndexesOf(view: SessionView): SessionIndexes {
  let indexes = SESSION_INDEXES.get(view.runs);
  if (!indexes) {
    indexes = {
      listed: new Set(),
      ended: new Set(),
      byOwner: new Map(),
      claims: new Map(),
      latest: new Map(),
      inflight: new Map(),
      local: { self: [], dead: [], unreadable: [] },
    };
    SESSION_INDEXES.set(view.runs, indexes);
  }
  return indexes;
}

// ---------------------------------------------------------------------------
// Copy on touch (D5): the containers this call owns
// ---------------------------------------------------------------------------

/**
 * The maps and arrays this `fold` call created: written directly. Any other
 * container belongs to a published level and is copied on its first write,
 * into the envelope being built. Reset at `fold` entry, so a throw mid-fold
 * cannot carry ownership into the next call.
 */
let owned = new WeakSet<object>();

type ViewMapKey = 'runs' | 'policy' | 'folded' | 'queuedFollowUps';

/** The view's map under `key`, copied once per call before its first write. */
function writableMap<K extends ViewMapKey>(
  view: SessionView,
  key: K,
): SessionView[K] {
  const current = view[key];
  if (owned.has(current)) return current;
  const copy = new Map(
    current as Iterable<readonly [unknown, unknown]>,
  ) as SessionView[K];
  if (key === 'runs') {
    SESSION_INDEXES.set(copy as SessionView['runs'], sessionIndexesOf(view));
  }
  owned.add(copy);
  view[key] = copy;
  return copy;
}

type TranscriptArrayKey = 'rows' | 'taskGroups';

/**
 * The transcript's array under `key`, copied once per call before its first
 * write and landed on the transcript value. Only a value this call built
 * (`replaceTranscript`) is passed here, so the copy never reaches a
 * published level, and a branch this call never writes stays the array the
 * previous level published.
 */
function writableTranscriptArray<K extends TranscriptArrayKey>(
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

function inflightKey(runId: RunId, rowId: string): string {
  return `${runId}/${rowId}`;
}

/** Drop a run's live text and its streaming cursors: the run ended,
 *  was removed, or lost its transcript tier (5.2, "In-flight text"). */
function clearInflight(view: SessionView, run: RunView): void {
  const prefix = `${run.id}/`;
  const { inflight } = sessionIndexesOf(view);
  for (const key of inflight.keys()) {
    if (key.startsWith(prefix)) inflight.delete(key);
  }
  indexesOf(run.transcript).streaming.clear();
}

// ---------------------------------------------------------------------------
// Transcript indexes (fold-owned, never on the view)
// ---------------------------------------------------------------------------

/** One streaming row's measured live text: the projection of its session
 *  `inflight` entry, extended per chunk rather than re-measured. */
interface StreamingCursor {
  /** The last durable entry for the row: a first chunk projects it when the
   *  entry's own text was blank and gave no row. */
  readonly entry: StreamLogEntry;
  text: TranscriptText;
}

interface TranscriptIndexes {
  readonly source: StreamLog;
  readonly trace: ReturnType<typeof createTranscriptFold>;
  /** Row position by row id. */
  readonly rowIndex: Map<string, number>;
  /** Task-group position by group id. */
  readonly taskGroupIndex: Map<string, number>;
  /** The compaction projection's working state; `compaction` is its blocks. */
  readonly compactionState: CompactionActivityProjection;
  /** Measured live text per streaming row id. */
  readonly streaming: Map<string, StreamingCursor>;
  /** The newest thinking row, for `thinkingActive`. */
  thinkingRowId: string | undefined;
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
    settledRows: 0,
    run: null,
  };
  const source = new StreamLog();
  INDEXES.set(transcript, {
    source,
    trace: createTranscriptFold(source),
    rowIndex: new Map(),
    taskGroupIndex: new Map(),
    compactionState,
    streaming: new Map(),
    thinkingRowId: undefined,
    plan: undefined,
    workflowAttemptId: undefined,
  });
  return transcript;
}

// ---------------------------------------------------------------------------
// Run construction
// ---------------------------------------------------------------------------

/** A run with no rounds recorded yet. */
const NO_ROUNDS = Object.freeze({});

/** The run a run-aggregate event names; null for any other aggregate kind. */
function runIdOf(aggregateId: AggregateId): RunId | null {
  const target = aggregateTarget(aggregateId);
  return target.kind === 'run' ? target.id : null;
}

/** A run in its initial shape, minted by its `run.start` alone. */
function createRun(
  view: SessionView,
  event: RunStartEvent,
  id: RunId,
): RunView {
  const status = RUN_LIFECYCLE_READY;
  const identity = event.identity;
  const common = {
    id,
    identity,
    isRemote: event.isRemote,
    ownerId: sessionIndexesOf(view).claims.get(event.aggregateId) ?? null,
    label: runIdentityDisplayName(identity),
    description: null,
    model: null,
    modelLabel: null,
    command: null,
    inputFiles: [],
    worktree: event.worktree ?? null,
    status,
    substate: null,
    durableOutcome: null,
    statusDetail: null,
    ...runStatusCopy(status),
    createdAt: event.commit,
    launchedAt: event.at,
    runStartedAt: null,
    lastTimestamp: event.at,
    conversationProgress: { toolCallCount: 0 },
    stage: null,
    followUpSupport: event.userFollowUpSupport,
    resumeEligible:
      event.category === AgentCategory.ToolUse &&
      isPlainAgentIdentity(identity),
    context: null,
    parentId: event.parent === null ? null : event.parent.id,
    ancestors: [],
    childIds: [],
    rollup: { total: 0, running: 0, finished: 0 },
    approval: 'none' as const,
    readOnly: false,
    forceExpanded: false,
    group: 'recent' as const,
    usage: emptyUsageStats(),
    thinkingActive: false,
    compactingActive: false,
    latestLine: null,
    transcript: emptyTranscript(),
  };
  switch (event.category) {
    case AgentCategory.Workflow:
      return {
        ...common,
        category: AgentCategory.Workflow,
        files: NO_ROUNDS,
        missingOutputs: NO_ROUNDS,
        compileFailures: NO_ROUNDS,
      };
    case AgentCategory.ToolUse:
      return {
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
}

/**
 * Land a run value in the index and keep the paper-level rollup (5.1)
 * current from the group it left and the group it entered. Every write to
 * `view.runs` goes through here; `dropRun` is the one removal.
 */
function setRun(view: SessionView, run: RunView): void {
  const previous = view.runs.get(run.id);
  writableMap(view, 'runs').set(run.id, run);
  if (previous?.ownerId !== run.ownerId) {
    reindexOwner(view, run.id, previous?.ownerId ?? null, run.ownerId);
  }
  if (previous?.group !== run.group) {
    countGroups(view, previous?.group, run.group);
  }
}

function dropRun(view: SessionView, run: RunView): void {
  writableMap(view, 'runs').delete(run.id);
  reindexOwner(view, run.id, run.ownerId, null);
  sessionIndexesOf(view).ended.delete(run.id);
  countGroups(view, run.group, undefined);
}

function reindexOwner(
  view: SessionView,
  runId: RunId,
  from: string | null,
  to: string | null,
): void {
  const { byOwner } = sessionIndexesOf(view);
  if (from !== null) {
    const ownedIds = byOwner.get(from);
    ownedIds?.delete(runId);
    if (ownedIds?.size === 0) byOwner.delete(from);
  }
  if (to !== null) {
    let ownedIds = byOwner.get(to);
    if (!ownedIds) {
      ownedIds = new Set();
      byOwner.set(to, ownedIds);
    }
    ownedIds.add(runId);
  }
}

function countGroups(
  view: SessionView,
  left: RunView['group'] | undefined,
  entered: RunView['group'] | undefined,
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

function orderingKey(run: RunView): {
  name: string;
  creationTimestamp: number;
} {
  return { name: run.id, creationTimestamp: run.createdAt };
}

/** `ids` with `id` placed by the `runOrdering` rule. */
function insertOrdered(
  view: SessionView,
  ids: readonly RunId[],
  id: RunId,
): RunId[] {
  const next = ids.filter((existing) => existing !== id);
  const run = view.runs.get(id);
  if (!run) return next;
  const key = orderingKey(run);
  let at = next.length;
  for (let i = 0; i < next.length; i += 1) {
    const other = view.runs.get(next[i]);
    if (other && compareByNewestCreationTime(key, orderingKey(other)) < 0) {
      at = i;
      break;
    }
  }
  next.splice(at, 0, id);
  return next;
}

function withoutId(ids: readonly RunId[], id: RunId): RunId[] {
  return ids.filter((existing) => existing !== id);
}

/** Root first. A parent edge always names a run the view holds: the fold
 *  re-roots a child whose parent it lacks (5.2, `ancestors`). */
function ancestorsOf(view: SessionView, run: RunView): RunView['ancestors'] {
  const chain: RunView['ancestors'] = [];
  let parentId = run.parentId;
  while (parentId !== null) {
    const parent = view.runs.get(parentId);
    if (!parent) break;
    chain.unshift({ id: parent.id, label: parent.label });
    parentId = parent.parentId;
  }
  return chain;
}

/** Whether `run` is `ancestorId` itself or sits below it. */
function isDescendantOf(
  view: SessionView,
  run: RunView,
  ancestorId: RunId,
): boolean {
  let cursor: RunView | undefined = run;
  while (cursor) {
    if (cursor.id === ancestorId) return true;
    cursor =
      cursor.parentId === null ? undefined : view.runs.get(cursor.parentId);
  }
  return false;
}

/** Recompute `ancestors` for a run and its descendants (a moved subtree,
 *  or a relabelled parent). O(subtree), once per such change. */
function refreshAncestors(view: SessionView, runId: RunId): void {
  const run = view.runs.get(runId);
  if (!run) return;
  const ancestors = ancestorsOf(view, run);
  const unchanged =
    ancestors.length === run.ancestors.length &&
    ancestors.every(
      (a, i) =>
        a.id === run.ancestors[i].id && a.label === run.ancestors[i].label,
    );
  if (!unchanged) setRun(view, { ...run, ancestors });
  for (const childId of run.childIds) refreshAncestors(view, childId);
}

// ---------------------------------------------------------------------------
// Derived per-run facts
// ---------------------------------------------------------------------------

/**
 * `group`, `approval`, `readOnly`, `forceExpanded`, `rollup`,
 * `durableOutcome`, and the status copy from the run's own facts, the
 * local snapshot, and its children (5.2). Interrupted is owner loss: a
 * non-terminal run nobody holds, whether or not an approval is pending.
 * Somebody holds it when its owner is this process or a process whose lease
 * this one may not touch. Waiting needs a held owner: without one the same
 * pending request reads as interrupted, never waiting, because nothing is
 * listening for the answer; the durable phase and the listed approval stay,
 * so a resume can re-ask.
 */
function withAggregates(view: SessionView, run: RunView): RunView {
  const { local } = sessionIndexesOf(view);
  const owner = run.ownerId;
  const own = owner !== null && local.self.includes(owner);
  const heldBy =
    owner !== null && !own && !local.dead.includes(owner) ? owner : null;
  const heldElsewhere = heldBy !== null;
  const held = own || heldElsewhere;
  const pendingOwn = view.approvals.some((a) => a.runId === run.id);
  const interrupted = !isTerminalOutcomePhase(run.status) && !held;
  const waiting = pendingOwn && held;
  const durableOutcome =
    isTerminalOutcomePhase(run.status) &&
    (!own || sessionIndexesOf(view).ended.has(run.id))
      ? run.status
      : null;
  const unreadable = local.unreadable.find((u) => u.runId === run.id);
  const rollup = { total: 0, running: 0, finished: 0 };
  let descendantWaiting = false;
  let descendantNeedsUser = false;
  for (const childId of run.childIds) {
    const child = view.runs.get(childId);
    if (!child) continue;
    rollup.total += 1 + child.rollup.total;
    rollup.running +=
      (isInFlightPhase(child.status) ? 1 : 0) + child.rollup.running;
    rollup.finished +=
      (isTerminalOutcomePhase(child.status) ? 1 : 0) + child.rollup.finished;
    if (child.approval !== 'none') descendantWaiting = true;
    if (child.forceExpanded) descendantNeedsUser = true;
  }
  let group: RunView['group'] = 'recent';
  if (interrupted) group = 'interrupted';
  else if (waiting) group = 'waiting';
  else if (isInFlightPhase(run.status)) group = 'running';
  let approval: RunView['approval'] = 'none';
  if (waiting) approval = 'own';
  else if (descendantWaiting) approval = 'descendant';
  const copy = runStatusCopy(run.status, {
    substate: run.substate ?? undefined,
    interrupted,
  });
  const readOnly = heldElsewhere || unreadable !== undefined;
  const forceExpanded = waiting || interrupted || descendantNeedsUser;
  let statusDetail: string | null = unreadable?.detail ?? null;
  if (statusDetail === null && interrupted) {
    statusDetail = runInterruptedMessage();
  } else if (statusDetail === null && heldBy !== null) {
    statusDetail = runHeldMessage(ownerPid(heldBy));
  }
  if (
    run.group === group &&
    run.approval === approval &&
    run.readOnly === readOnly &&
    run.forceExpanded === forceExpanded &&
    run.durableOutcome === durableOutcome &&
    run.rollup.total === rollup.total &&
    run.rollup.running === rollup.running &&
    run.rollup.finished === rollup.finished &&
    run.statusLabel === copy.statusLabel &&
    run.tone === copy.tone &&
    run.statusDetail === statusDetail
  ) {
    return run;
  }
  return {
    ...run,
    group,
    approval,
    readOnly,
    forceExpanded,
    durableOutcome,
    rollup,
    ...copy,
    statusDetail,
  };
}

// ---------------------------------------------------------------------------
// Workflow-script run model
// ---------------------------------------------------------------------------

function isWorkflowScriptRun(run: RunView): boolean {
  return run.identity.kind === 'multiAgentWorkflow';
}

function childProgressOf(child: RunView): ChildRunProgress {
  const totals = child.usage;
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
function childProgressChanged(prev: RunView, next: RunView): boolean {
  if (prev === next) return false;
  if (
    prev.runStartedAt !== next.runStartedAt ||
    prev.conversationProgress.toolCallCount !==
      next.conversationProgress.toolCallCount
  ) {
    return true;
  }
  return (
    prev.usage.outputTokens !== next.usage.outputTokens ||
    prev.usage.cost !== next.usage.cost
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
function withRunModel(view: SessionView, run: RunView): RunView {
  if (!isWorkflowScriptRun(run)) return run;
  const childProgress = new Map<RunId, ChildRunProgress>();
  for (const childId of run.childIds) {
    const child = view.runs.get(childId);
    if (child) childProgress.set(childId, childProgressOf(child));
  }
  const transcript = run.transcript;
  const indexes = indexesOf(transcript);
  const runModel = workflowRunModel({
    ...runModelInputs(transcript),
    workflowAttemptId: indexes.workflowAttemptId,
    plan: indexes.plan,
    runPhase: run.status,
    // A terminal outcome with nothing left to settle its cards.
    runDurablyFinal: run.durableOutcome !== null,
    childProgress,
  });
  return {
    ...run,
    transcript: replaceTranscript(transcript, { run: runModel }),
  };
}

/** Derive the run model now, or note the run for the end of the batch. */
function runModelAt(
  view: SessionView,
  run: RunView,
  deferred: DeferredRunModels,
): RunView {
  if (!isWorkflowScriptRun(run)) return run;
  if (deferred) {
    deferred.add(run.id);
    return run;
  }
  return withRunModel(view, run);
}

/**
 * Re-derive the aggregates of `startId` and every ancestor above it. The run
 * model is re-derived at `boardId` only: a board joins its direct children's
 * progress, so a grandchild's change stops at its own parent.
 */
function walkUp(
  view: SessionView,
  startId: RunId | null,
  boardId: RunId | null,
  deferred: DeferredRunModels,
): void {
  const seen = new Set<RunId>();
  let id = startId;
  while (id !== null && !seen.has(id)) {
    seen.add(id);
    const current = view.runs.get(id);
    if (!current) return;
    let next = withAggregates(view, current);
    if (id === boardId) next = runModelAt(view, next, deferred);
    if (next !== current) setRun(view, next);
    id = current.parentId;
  }
}

// ---------------------------------------------------------------------------
// Transcript slice
// ---------------------------------------------------------------------------

function upsertRow(transcript: TranscriptView, row: TranscriptRow): void {
  // The one writer of `rows`: the copy belongs to the write, so an entry
  // that projects no row leaves the array the previous level published.
  const rows = writableTranscriptArray(transcript, 'rows');
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
 * Whether a run's run, round, and session headings go to the task-group
 * surface rather than the rows (keyed on the identity, never the id format):
 * every workflow run and every plain agent run. The one exception is a
 * full-log child that is not a workflow run, a detached process or an
 * external-CLI session, whose verbatim log is the point of opening it.
 */
function lifecycleToTaskGroups(run: RunView): boolean {
  return (
    run.category === AgentCategory.Workflow ||
    isPlainAgentIdentity(run.identity)
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

/**
 * Fold one transcript row into the slice: the row, task-group, compaction,
 * and run-marker reducers, each called unchanged. A streaming row joins its
 * durable fields with its session `inflight` entry, which may have arrived
 * first (5.2, "In-flight text"); a finalizing row drops that entry, so a
 * late chunk cannot reopen settled text.
 */
function applyEntry(
  view: SessionView,
  run: RunView,
  entry: StreamLogEntry,
): TranscriptView {
  const next = replaceTranscript(run.transcript, {});
  const indexes = indexesOf(next);
  // Task groups are copied by the entry that lands one, never by an
  // ordinary model or log entry, which the projection would not write.
  if (isTaskGroupLifecycleEntry(entry)) {
    upsertTaskGroupFromStreamLog(
      writableTranscriptArray(next, 'taskGroups'),
      indexes.taskGroupIndex,
      entry,
    );
  }
  const marker = workflowMarkerOf(entry);
  if (marker) {
    indexes.workflowAttemptId = marker.attemptId ?? indexes.workflowAttemptId;
    indexes.plan = marker.kind === 'plan' ? marker.plan : undefined;
  }
  reconcileCompactionRows(
    next,
    applyCompactionActivityEntries(indexes.compactionState, [entry]),
  );
  const key = inflightKey(run.id, entry.id);
  const { inflight } = sessionIndexesOf(view);
  // One holder of a row's live text, the session `inflight` index, whichever
  // arrives first: chunks extend it, and an entry that folds before any chunk
  // seeds it with the text it carried, so the chunk re-delivering that text
  // from offset zero (the bridge seeds one for every running row it
  // publishes) ends within the length held and is dropped (5.2, "In-flight
  // text").
  if (isStreamingEntry(entry) && entry.text && !inflight.has(key)) {
    inflight.set(key, entry.text);
  }
  const live = isStreamingEntry(entry) ? inflight.get(key) : undefined;
  projectRow(
    next,
    live === undefined ? entry : { ...entry, text: live },
    lifecycleToTaskGroups(run),
  );
  const row = rowById(next, entry.id);
  if (row?.kind === 'thinking') {
    const newest = indexes.thinkingRowId;
    const at = indexes.rowIndex.get(row.id)!;
    if (newest === undefined || indexes.rowIndex.get(newest)! <= at) {
      indexes.thinkingRowId = row.id;
    }
  }
  if (isStreamingEntry(entry)) {
    const text = live ?? '';
    indexes.streaming.set(entry.id, {
      entry,
      // The projected row already measured the text; a blank entry has none.
      text: row && isStreamingTextRow(row) ? row.text : transcriptText(text),
    });
  } else {
    indexes.streaming.delete(entry.id);
    inflight.delete(key);
  }
  return next;
}

/** Finalize unmatched compaction starts when the turn settles. */
function withSettledTranscript(run: RunView, finishedAt: number): RunView {
  if (!isTranscriptSettlementPhase(run.status)) return run;
  const changed = settleCompactionActivities(
    indexesOf(run.transcript).compactionState,
    { finishedAt },
  );
  if (changed.length === 0) return run;
  const transcript = replaceTranscript(run.transcript, {});
  reconcileCompactionRows(transcript, changed);
  return { ...run, transcript };
}

// ---------------------------------------------------------------------------
// Transcript-derived run facts (G4: derived in the fold, never by a host)
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
 * frontier is walked. A final run settles every open row except the two
 * kinds whose state bridge cleanup can still replace (a compaction block, a
 * workflow card).
 */
function advanceSettledRows(
  rows: readonly TranscriptRow[],
  start: number,
  runFinal: boolean,
): number {
  let index = Math.min(start, rows.length);
  while (index < rows.length) {
    const row = rows[index];
    if (!isSettledRow(row, index < rows.length - 1)) {
      if (promotesOnlyOnTypedTerminalState(row) || !runFinal) break;
    }
    index += 1;
  }
  return index;
}

/** The transcript-derived fields of a run, after its rows or its
 *  settlement moved: `settledRows`, `thinkingActive`, `compactingActive`,
 *  and `latestLine`. */
function withTranscriptFacts(run: RunView): RunView {
  const { transcript } = run;
  const runFinal = isTranscriptSettlementPhase(run.status);
  const settledRows = advanceSettledRows(
    transcript.rows,
    transcript.settledRows,
    runFinal,
  );
  const { thinkingRowId } = indexesOf(transcript);
  const lastThinking =
    thinkingRowId === undefined
      ? undefined
      : rowById(transcript, thinkingRowId);
  const thinkingActive =
    lastThinking?.kind === 'thinking' && lastThinking.streaming;
  const compactingActive = indexesOf(transcript).compactionState.blocks.some(
    (block) => block.status === 'running',
  );
  const latestLine =
    (run.category === AgentCategory.Workflow
      ? workflowOperationalLatestLine(transcript.rows)
      : latestConversationLine(transcript.rows, settledRows)) ?? run.latestLine;
  if (
    settledRows === transcript.settledRows &&
    thinkingActive === run.thinkingActive &&
    compactingActive === run.compactingActive &&
    latestLine === run.latestLine
  ) {
    return run;
  }
  return {
    ...run,
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
 * Apply one live chunk (5.2, "Live text"): ignored when its `to` is not past
 * the text held, otherwise the held text is truncated at `from` and the
 * chunk appended, so a redelivery in any order is a no-op and a `from: 0`
 * chunk replaces the row. An append costs the chunk, never the row; the
 * embedded-followup flag is the one whole-text scan, and it runs only while
 * a block is open or the chunk could open one. A chunk for a run the
 * view does not hold is dropped, and durable text wins: a row whose
 * finalizing event has folded is never reopened. Returns whether the chunk
 * changed anything.
 */
function foldTextChunk(view: SessionView, chunk: TextChunk): boolean {
  const run = view.runs.get(chunk.runId);
  if (!run) return false;
  const indexes = indexesOf(run.transcript);
  const cursor = indexes.streaming.get(chunk.rowId);
  if (!cursor && rowById(run.transcript, chunk.rowId)) return false;
  const key = inflightKey(chunk.runId, chunk.rowId);
  const { inflight } = sessionIndexesOf(view);
  const held = inflight.get(key) ?? '';
  if (chunk.to <= held.length) return false;
  if (chunk.from > held.length) {
    throw new Error(
      `text chunk for ${key} starts at ${chunk.from}, past the ${held.length} characters held`,
    );
  }
  const text = held.slice(0, chunk.from) + chunk.text;
  inflight.set(key, text);
  // The row projects when its entry folds, joined with this entry.
  if (!cursor) return true;
  cursor.text =
    chunk.from === held.length
      ? appendTranscriptText(cursor.text, chunk.text, held.at(-1) ?? '')
      : transcriptText(text);
  const transcript = replaceTranscript(run.transcript, {});
  const at = indexes.rowIndex.get(chunk.rowId);
  const row = at === undefined ? undefined : transcript.rows[at];
  if (at !== undefined && row && isStreamingTextRow(row)) {
    const { pendingEmbeddedFollowup: wasPending, ...rest } = row;
    const pending =
      row.kind === 'assistant' && (wasPending || chunk.text.includes('<'))
        ? hasIncompleteEmbeddedSubagentFollowup(cursor.text.full)
        : wasPending;
    writableTranscriptArray(transcript, 'rows')[at] = {
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
      lifecycleToTaskGroups(run),
    );
  }
  setRun(view, { ...run, transcript });
  return true;
}

// ---------------------------------------------------------------------------
// Durable events
// ---------------------------------------------------------------------------

/** A tool-use fact on a run whose arm cannot hold it is a publisher or
 *  category defect, made loud at the fold's boundary. */
function wrongArm(run: RunView, event: DisplaySessionEvent): never {
  throw new Error(
    `${event.type} names ${run.id}, a ${run.category} run; the fact belongs to the ${AgentCategory.ToolUse} arm`,
  );
}

/** The event's own arm applied to its run (topology, session slices, and
 *  the transcript tier are handled by the caller). */
function applyOwnArm(
  run: RunView,
  event: Exclude<DisplaySessionEvent, TranscriptEntryEvent>,
): RunView {
  switch (event.type) {
    case 'log':
    case 'stage.end':
    case 'tool.start':
    case 'tool.end':
    case 'workflow.plan':
    case 'workflow.call':
    case 'skills.snapshot':
    case 'stream.start':
    case 'stream.end':
    case 'response.finalized':
    case 'domain':
      return run;
    case 'run.start':
      // Existence cannot become more true (5.2, "Duplicates"): a second
      // start for a run the view holds is a no-op.
      return run;
    case 'run.activate':
      // Ownership moves with the envelope the caller stamps; the activation
      // metadata repeats the launch facts the run already carries.
      return run;
    case 'run.config': {
      const model = run.identity.kind === 'agent' ? event.config.model : null;
      return {
        ...run,
        model,
        modelLabel: model === null ? null : getModelLabel(model),
        command:
          run.identity.kind === 'process' ? event.config.instruction : null,
        inputFiles: event.config.inputFiles,
      };
    }
    case 'status': {
      const freshRun =
        event.phase === RUN_PHASE.RUNNING &&
        event.previousPhase !== RUN_PHASE.RUNNING;
      return withSettledTranscript(
        {
          ...run,
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
    case 'stage.start': {
      const stage = runStageFromStageStart({
        kind: event.kind ?? undefined,
        label: event.label,
        index: event.index ?? undefined,
        total: event.total ?? undefined,
      });
      return stage ? { ...run, stage } : run;
    }
    case 'conversation.progress':
      return { ...run, conversationProgress: event.progress };
    case 'usage':
      // `usage` is a latest-only listing key, so a cold read delivers exactly
      // one row per run: the row must be — and is — the run's cumulative
      // total, published by the single reporter for that run (`UsageMonitor`
      // for a model-driven run, the agent-CLI loop for its own child run).
      // The newest row therefore replaces the total; summing here would
      // double-count every earlier round an aggregate replay brings on top of
      // the listing row. The one-element sum normalizes the extended payload
      // (`elapsedTime`, `percentageCached`, `toolUseTokens`) down to the
      // view's `TokenUsageStats` shape.
      return { ...run, usage: sumUsageStats([event.usage]) };
    case 'context.state':
      return {
        ...run,
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
      return run.category === AgentCategory.ToolUse
        ? { ...run, todos: event.todos }
        : wrongArm(run, event);
    case 'updatePlan':
      return run.category === AgentCategory.ToolUse
        ? { ...run, plan: event.plan }
        : wrongArm(run, event);
    case 'goalStateChanged':
      return run.category === AgentCategory.ToolUse
        ? { ...run, goal: event.state }
        : wrongArm(run, event);
    // The three round-keyed facts are latest-only listing keys, so a cold
    // read delivers exactly one row of each per run and the commit guard
    // drops the earlier rows an aggregate replay brings: each row carries
    // the run's whole map (the producer holds it in `OutputState`), and the
    // newest row therefore replaces the map rather than merging into it.
    case 'addOutputFiles':
      return run.category === AgentCategory.Workflow
        ? { ...run, files: nonEmptyRounds(event.filesByRound) }
        : { ...run, outputs: nonEmptyRounds(event.filesByRound) };
    case 'updateMissingOutputs':
      // An empty round here is a fact, not an absence: the round was checked
      // and nothing was missing.
      return { ...run, missingOutputs: { ...event.filesByRound } };
    case 'updateCompileFailures':
      return {
        ...run,
        compileFailures: nonEmptyRounds(event.filesByRound),
      };
    case 'run.detach':
      // The edge severed: the child is top level from here (one run model,
      // section 3.2). A run never acquires a new parent.
      return run.parentId === null ? run : { ...run, parentId: null };
    case 'run.description':
      return { ...run, description: event.description };
    case 'run.end':
      // The terminal fact: the phase is its outcome (one run model, section
      // 3.3). The caller records that the run ended.
      return withSettledTranscript(
        {
          ...run,
          status: event.outcome,
          substate: null,
          runStartedAt: null,
        },
        event.at,
      );
    case 'approval.requested':
    case 'approval.resolved':
    case 'approval.policy':
    case 'inquiryThreadUpdated':
    case 'updateQueuedFollowUps':
    case 'run.removed':
      return run;
    case 'flow.step':
      // Inert in PR 1: `listingTypeOf` returns null, so `foldDurable`
      // returns before this switch. PR 3 gives it real handling.
      return run;
  }
}

/** Session-level slices, applied before the run arm so the arm's
 *  aggregates see them. */
function applySessionSlices(
  view: SessionView,
  runId: RunId | null,
  event: DisplaySessionEvent,
): void {
  switch (event.type) {
    case 'run.start':
      // The initial snapshot rides the existence fact (PRD 6, item 2); a
      // legacy import carries none and leaves the entry to `approval.policy`.
      if (event.approvalPolicy && runId !== null) {
        writableMap(view, 'policy').set(runId, event.approvalPolicy);
      }
      return;
    case 'approval.requested':
      // A set keyed by request id (5.2); a replayed request is below the
      // pair's `latest` entry and never reaches here.
      if (runId === null) return;
      view.approvals = [
        ...view.approvals,
        {
          runId,
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
      if (runId !== null)
        writableMap(view, 'policy').set(runId, event.snapshot);
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
      if (runId !== null)
        writableMap(view, 'queuedFollowUps').set(runId, event.messages);
      return;
    default:
      return;
  }
}

/**
 * Move `run` from `previousParentId` to its current parent. A parent the
 * view has no `run.start` for re-roots the run: top-level, no ancestors
 * (5.2, `ancestors`).
 */
function relink(
  view: SessionView,
  run: RunView,
  previousParentId: RunId | null,
): void {
  const previousParent =
    previousParentId === null ? undefined : view.runs.get(previousParentId);
  if (previousParent) {
    setRun(view, {
      ...previousParent,
      childIds: withoutId(previousParent.childIds, run.id),
    });
  }
  let parent = run.parentId === null ? undefined : view.runs.get(run.parentId);
  if (parent && isDescendantOf(view, parent, run.id)) {
    // An edge onto the run's own subtree would close a loop; the tree is
    // what every reader walks, so the edge is refused and the run keeps
    // its previous parent (or the top level).
    parent = previousParent;
    setRun(view, { ...run, parentId: previousParent?.id ?? null });
  } else if (!parent && run.parentId !== null) {
    setRun(view, { ...run, parentId: null });
  }
  if (parent) {
    setRun(view, {
      ...parent,
      childIds: insertOrdered(view, parent.childIds, run.id),
    });
  }
  const inOrder = view.order.includes(run.id);
  if (!parent && !inOrder) {
    view.order = insertOrdered(view, view.order, run.id);
  }
  if (parent && inOrder) view.order = withoutId(view.order, run.id);
  refreshAncestors(view, run.id);
}

/** The run a durable event names: its aggregate, except for the thread
 *  aggregate of an inquiry (5.1). */
function runOfEvent(event: DisplaySessionEvent): RunId | null {
  return event.type === 'inquiryThreadUpdated'
    ? null
    : runIdOf(event.aggregateId);
}

/** Returns whether the event changed anything. */
function foldDurable(
  view: SessionView,
  event: DisplaySessionEvent,
  deferred: DeferredRunModels,
  read: 'listing' | 'aggregate' | 'all',
): boolean {
  if (event.type === 'transcript.entry') {
    return foldTranscriptRow(view, event, deferred);
  }
  const traceChanged =
    read !== 'listing' &&
    (isTranscriptEvent(event) ||
      event.type === 'status' ||
      event.type === 'run.end')
      ? foldTraceEvent(view, event, deferred)
      : false;
  if (listingTypeOf(event) === null) return traceChanged;
  // Listing facts are ordered by commit per (aggregate, listing type),
  // whichever read delivered them (5.2, "Duplicates").
  const listingKey = `${event.aggregateId}/${listingTypeOf(event)}`;
  const { latest } = sessionIndexesOf(view);
  const newest = latest.get(listingKey);
  if (newest !== undefined && event.commit <= newest) return traceChanged;

  const runId = runOfEvent(event);
  if (runId === null) {
    latest.set(listingKey, event.commit);
    applySessionSlices(view, null, event);
    return true;
  }
  const known = view.runs.get(runId);
  // Existence: only `run.start` mints a run, once. A fact for a run
  // the view has no `run.start` for changes nothing and leaves no entry (its
  // publisher logs it).
  if (!known && event.type !== 'run.start') return false;
  latest.set(listingKey, event.commit);
  if (event.type === 'run.removed') {
    return foldRunRemoved(view, runId, deferred);
  }
  const created = !known;
  const before = known ?? createRun(view, event as RunStartEvent, runId);

  applySessionSlices(view, runId, event);
  const own = applyOwnArm(before, event);
  if (event.type === 'run.end') {
    // The run ended; a terminal phase ends every live row (5.2, "In-flight
    // text": a run can end with a row unfinalized).
    sessionIndexesOf(view).ended.add(runId);
    clearInflight(view, own);
  }
  // A fresh run can end again.
  if (
    event.type === 'status' &&
    own.status === RUN_PHASE.RUNNING &&
    before.status !== own.status
  ) {
    sessionIndexesOf(view).ended.delete(runId);
  }
  let next: RunView = {
    ...own,
    lastTimestamp: event.at,
  };
  setRun(view, next);

  if (created || next.parentId !== before.parentId) {
    relink(view, next, created ? null : before.parentId);
    if (!created) walkUp(view, before.parentId, before.parentId, deferred);
  }
  if (next.label !== before.label) {
    for (const childId of next.childIds) refreshAncestors(view, childId);
  }
  next = view.runs.get(next.id)!;
  const aggregated =
    own.status !== before.status
      ? withAggregates(view, withTranscriptFacts(next))
      : withAggregates(view, next);
  // The run model's own inputs: the run's existence and status.
  const runInputsMoved = created || own.status !== before.status;
  setRun(
    view,
    runInputsMoved ? runModelAt(view, aggregated, deferred) : aggregated,
  );
  // A board's inputs from a child: the child being under it (created, or
  // moved there by `relink` above) and the child's progress.
  walkUp(
    view,
    next.parentId,
    created ||
      next.parentId !== before.parentId ||
      childProgressChanged(before, next)
      ? next.parentId
      : null,
    deferred,
  );
  return true;
}

/** Replay and live durable inputs use one trace projection for each resident aggregate. */
function foldTraceEvent(
  view: SessionView,
  event: DisplaySessionEvent,
  deferred: DeferredRunModels,
): boolean {
  const retained = view.folded.get(event.aggregateId);
  if (retained === undefined || event.seq <= retained) return false;
  const runId = runIdOf(event.aggregateId);
  let run = runId === null ? undefined : view.runs.get(runId);
  if (!run) return false;
  const indexes = indexesOf(run.transcript);
  if (event.type === 'status') indexes.trace.status(event.phase);
  else if (event.type === 'run.end') indexes.trace.status(event.outcome);
  else if (isTranscriptEvent(event))
    indexes.trace.record(event, {
      at: event.at,
      id: JSON.stringify([event.aggregateId, event.seq]),
      debug: event.transcriptDebug ?? false,
    });
  const change = indexes.source.drainEmission();
  for (const entry of [...change.appended, ...change.dirtied]) {
    run = { ...run, transcript: applyEntry(view, run, entry) };
  }
  writableMap(view, 'folded').set(event.aggregateId, event.seq);
  // A filtered fact still advances its source cursor. Keep the run and
  // transcript references stable when that fact produced no presentation.
  if (change.appended.length === 0 && change.dirtied.length === 0) return true;
  setRun(
    view,
    runModelAt(
      view,
      withTranscriptFacts({ ...run, lastTimestamp: event.at }),
      deferred,
    ),
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
  event: TranscriptEntryEvent,
  deferred: DeferredRunModels,
): boolean {
  const retained = view.folded.get(event.aggregateId);
  if (retained === undefined || event.seq <= retained) return false;
  const runId = runIdOf(event.aggregateId);
  const run = runId === null ? undefined : view.runs.get(runId);
  if (!run) return false;
  writableMap(view, 'folded').set(event.aggregateId, event.seq);
  const withEntry: RunView = {
    ...run,
    lastTimestamp: event.at,
    transcript: applyEntry(view, run, event.entry),
  };
  const next = withTranscriptFacts(withEntry);
  setRun(view, next);
  if (entryAffectsRunModel(event.entry)) {
    setRun(view, runModelAt(view, next, deferred));
  }
  return true;
}

/**
 * The tombstone (5.2, "Existence" and "Durable text wins"): final, clears
 * every session-level entry keyed by the run, re-roots its children, and
 * ends its transcript tier. The run's `latest` entries stay: the
 * lifecycle one is what outranks a replayed `run.start` beneath the
 * tombstone.
 */
function foldRunRemoved(
  view: SessionView,
  runId: RunId,
  deferred: DeferredRunModels,
): boolean {
  const run = view.runs.get(runId);
  if (!run) return false;
  dropRun(view, run);
  clearInflight(view, run);
  // A map that never held this run is left alone: a delete that removes
  // nothing must not copy the map it publishes.
  if (view.policy.has(run.id)) writableMap(view, 'policy').delete(run.id);
  if (view.queuedFollowUps.has(run.id)) {
    writableMap(view, 'queuedFollowUps').delete(run.id);
  }
  writableMap(view, 'folded').delete(qualifyAggregateId('run', run.id));
  if (view.approvals.some((a) => a.runId === run.id)) {
    view.approvals = view.approvals.filter((a) => a.runId !== run.id);
  }
  if (view.inquiries.some((i) => i.parentRunId === run.id)) {
    view.inquiries = view.inquiries.filter((i) => i.parentRunId !== run.id);
  }
  view.order = withoutId(view.order, run.id);
  const parent =
    run.parentId === null ? undefined : view.runs.get(run.parentId);
  if (parent) {
    setRun(view, {
      ...parent,
      childIds: withoutId(parent.childIds, run.id),
    });
    walkUp(view, parent.id, parent.id, deferred);
  }
  // A child whose parent is gone is top-level: no dangling edge, no
  // ancestors (5.2, `ancestors`).
  for (const childId of run.childIds) {
    const child = view.runs.get(childId);
    if (!child) continue;
    setRun(view, { ...child, parentId: null });
    view.order = insertOrdered(view, view.order, childId);
    refreshAncestors(view, childId);
  }
  return true;
}

/**
 * The local snapshot names the runs whose owner entered or left the held
 * set and those entering or leaving `unreadable` (5.2, "Incremental"), so an
 * owner exiting recomputes exactly the runs it owned, never the view.
 */
function foldLocal(
  view: SessionView,
  local: LocalRuntimeState,
  deferred: DeferredRunModels,
): void {
  const indexes = sessionIndexesOf(view);
  const previous = indexes.local;
  indexes.local = local;
  const heldBefore = new Set([...previous.self, ...previous.dead]);
  const heldAfter = new Set([...local.self, ...local.dead]);
  const changedOwners = new Set<string>();
  for (const owner of heldBefore) {
    if (!heldAfter.has(owner)) changedOwners.add(owner);
  }
  for (const owner of heldAfter) {
    if (!heldBefore.has(owner)) changedOwners.add(owner);
  }
  // Changes between self and a proved-dead verdict also change ownership:
  // an owner moving between them, in either direction, changes that answer
  // while staying held.
  for (const owner of heldAfter) {
    if (previous.self.includes(owner) !== local.self.includes(owner)) {
      changedOwners.add(owner);
    }
  }
  const touched = new Set<RunId>();
  for (const owner of changedOwners) {
    for (const runId of indexes.byOwner.get(owner) ?? []) {
      touched.add(runId);
    }
  }
  const unreadableBefore = new Map(
    previous.unreadable.map((u) => [u.runId, u.detail]),
  );
  const unreadableAfter = new Map(
    local.unreadable.map((u) => [u.runId, u.detail]),
  );
  for (const [runId, detail] of unreadableBefore) {
    if (unreadableAfter.get(runId) !== detail) touched.add(runId);
  }
  for (const [runId, detail] of unreadableAfter) {
    if (unreadableBefore.get(runId) !== detail) touched.add(runId);
  }
  for (const runId of touched) walkUp(view, runId, runId, deferred);
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
    if (!view.folded.has(id)) writableMap(view, 'folded').set(id, fromSeq);
  }
  for (const id of [...view.folded.keys()]) {
    if (subscribed.has(id)) continue;
    writableMap(view, 'folded').delete(id);
    const target = aggregateTarget(id);
    const run = target.kind === 'run' ? view.runs.get(target.id) : undefined;
    if (!run) continue;
    clearInflight(view, run);
    const evicted = withTranscriptFacts({
      ...run,
      transcript: emptyTranscript(),
    });
    setRun(view, runModelAt(view, evicted, deferred));
  }
}
