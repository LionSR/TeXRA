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
 * is above that entry, which it then advances; `view.cursor` moves on tail
 * rows alone. Existence: a run exists iff its `run.start` has folded and its
 * `run.removed` has not; the two share one `latest` entry, so the tombstone
 * is final under every read, ids are never reused (decision 9), and a fact
 * naming any other run changes nothing. Listing hydration is authoritative
 * (7.2): at the replay marker every run no listing row of that sequence
 * named is removed the way a tombstone removes it.
 *
 * The run model (`transcript.run`) is derived only when one of its inputs
 * moved: the run's own `run.start`, a status change, a transcript entry the
 * model reads (a workflow card, a group boundary, a plan), or a
 * direct child's progress. Folding a frame defers that derivation to the
 * end of the frame, so a replay of R events derives each board once.
 *
 * Publication (D5): returned views are immutable; untouched branches retain
 * identity. writableMap and the transcript fold copy each changed container
 * at most once per fold, and writes stop when fold returns. No-op writes keep
 * the previous branch. RunView, TranscriptView, and SessionView are replaced
 * on change, preserving older views and identity-based host comparisons.
 * Indexes are module-private, keyed by their transcript/view, and advance only
 * with the latest level: row/group positions, text and thinking state, claims,
 * listing commits, owners, ended/listed runs, snapshots, and shared-row slices.
 * Every container write must report changed so foldWith publishes its copy.
 */

import {
  aggregateTarget,
  nonEmptyRounds,
  aggregateId as qualifyAggregateId,
  AgentCategory,
  MESSAGE_TYPES,
  RUN_PHASE,
  RUN_LIFECYCLE_READY,
  RUN_SUBSTATE,
  isPlainAgentIdentity,
  listingKeyOf,
  isTranscriptEvent,
  ownerPid,
  requestParksItsCaller,
  runIdentityDisplayName,
  emptyUsageStats,
  sumUsageStats,
  type AggregateId,
  type FoldInput,
  type ExistenceReconciliation,
  type LocalRuntimeState,
  type DisplaySessionEvent,
  type RoundOutput,
  type RunId,
  type TextChunk,
  type TranscriptSubscription,
} from '@shared/schemas';
import { getModelLabel } from '@shared/model/modelLabel';
import { roundedUtilizationPercent } from '@shared/runs/contextUtilization';
import { compareByNewestCreationTime } from '@shared/runs/runOrdering';
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
  workflowRunModel,
  type ChildRunProgress,
} from '@shared/runs/workflowRunModel';
import { isSettledRow, rowHeadline, type TranscriptRow } from '@ui/transcript';
import {
  applyRunRow,
  freshRunRows,
  isSharedRunRow,
  phaseMoveOf,
  type RunRows,
  type SharedRunRow,
} from './runRows';
import { foldTranscriptEvent } from './transcriptFold';
import {
  clearLiveText,
  foldLiveText,
  runModelInputs,
  settleTranscript,
  transcriptActivity,
} from './transcriptReads';
import {
  emptyTranscript,
  lifecycleToTaskGroups,
  replaceTranscript,
  resetTranscriptOwnership,
  type TranscriptContext,
} from './transcriptState';

import { emptySessionView, isLiveRun } from './sessionView';
import type { SessionView, RunView, TranscriptView } from './sessionView';

type RunStartEvent = Extract<DisplaySessionEvent, { type: 'run.start' }>;

/** Workflow-script run ids whose run model a batch derives at its end. */
type DeferredRunModels = Set<RunId> | null;
/** One input, or a frame of them (the transport's unit, 7.4 and 8.1) or a
 *  replay: every input in order, with each touched workflow board's run
 *  model derived once at the end instead of once per event. */
export function fold(
  view: SessionView,
  input: FoldInput | readonly FoldInput[],
): SessionView {
  // One call publishes one level: nothing this call did not copy is written.
  owned = new WeakSet();
  resetTranscriptOwnership();
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
    case 'debug':
      if (next.debug === input.enabled) return view;
      return emptySessionView(view.key, 0, input.enabled);
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
    // The transcript tier belongs to the subscription set alone (5.2,
    // "Residency"): `foldSubscriptions` opens the `folded` entry and closes
    // it, and the tombstone below ends it with its run. A reader reports an
    // aggregate with no sequence row as absent whether it was removed or has
    // not started yet, so ending the tier here would drop the rows of a
    // stream a subscription named before its `run.start` committed.
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
  /** What the rows both folds read say about each run (`runRows.ts`);
   *  `view.requests`, `view.queuedFollowUps`, `RunView.flow` and the run's
   *  output rounds project it. */
  readonly rows: Map<RunId, RunRows>;
  /** One entry per `${aggregate}/${listing type}`: the commit of the latest
   *  listing fact folded for it, so a replayed older one is ignored. The
   *  lifecycle entry outlives its run: it is what keeps a tombstone
   *  final when a read replays the `run.start` beneath it. */
  readonly latest: Map<string, number>;
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
      rows: new Map(),
      latest: new Map(),
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
    flow: null,
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
    ownedHere: false,
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
    const ownedIds = byOwner.get(to) ?? new Set<RunId>();
    ownedIds.add(runId);
    byOwner.set(to, ownedIds);
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
  const next = withoutId(ids, id);
  const run = view.runs.get(id);
  if (!run) return next;
  const key = orderingKey(run);
  const at = next.findIndex((otherId) => {
    const other = view.runs.get(otherId);
    return (
      other !== undefined &&
      compareByNewestCreationTime(key, orderingKey(other)) < 0
    );
  });
  next.splice(at < 0 ? next.length : at, 0, id);
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
 * this one may not touch. Waiting needs a held owner and a request that parks
 * its tool: without an owner the same pending request reads as interrupted,
 * never waiting, because nothing is listening for the answer; the durable
 * phase and the listed request stay, so a resume can re-ask.
 */
function withAggregates(view: SessionView, run: RunView): RunView {
  const { local } = sessionIndexesOf(view);
  const owner = run.ownerId;
  const own = owner !== null && local.self.includes(owner);
  const heldBy =
    owner !== null && !own && !local.dead.includes(owner) ? owner : null;
  const heldElsewhere = heldBy !== null;
  const held = own || heldElsewhere;
  // Only a request that parks its tool is a wait: a dispatched inquiry left
  // its run working, so it stays listed for the panel without moving the run
  // out of Running.
  const pendingOwn = view.requests.some(
    (r) => r.runId === run.id && requestParksItsCaller(r.payload),
  );
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
    rollup.running += (isLiveRun(child) ? 1 : 0) + child.rollup.running;
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
    run.ownedHere === own &&
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
    ownedHere: own,
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
  return (
    prev.runStartedAt !== next.runStartedAt ||
    prev.conversationProgress.toolCallCount !==
      next.conversationProgress.toolCallCount ||
    prev.usage.outputTokens !== next.usage.outputTokens ||
    prev.usage.cost !== next.usage.cost
  );
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
  const runModel = workflowRunModel({
    ...runModelInputs(transcript),
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

/** Finalize unmatched compaction starts when the turn settles. */
function withSettledTranscript(run: RunView, finishedAt: number): RunView {
  if (!isTranscriptSettlementPhase(run.status)) return run;
  const transcript = settleTranscript(run.transcript, finishedAt);
  return transcript === run.transcript ? run : { ...run, transcript };
}

// ---------------------------------------------------------------------------
// Transcript-derived run facts (G4: derived in the fold, never by a host)
// ---------------------------------------------------------------------------

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
      // Bridge cleanup can still replace a planned/running compaction or
      // workflow call after a cancellation, so those two settle only on their
      // own typed terminal state, never on the final stream status.
      if (
        row.kind === 'compactionActivity' ||
        row.kind === 'workflowTask' ||
        !runFinal
      ) {
        break;
      }
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
  const { thinkingActive, compactingActive } = transcriptActivity(transcript);
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

/** Apply one live chunk (5.2, "Live text") to its run's transcript; a chunk
 *  for a run the view does not hold is dropped. Returns whether the chunk
 *  changed anything. */
function foldTextChunk(view: SessionView, chunk: TextChunk): boolean {
  const run = view.runs.get(chunk.runId);
  if (!run) return false;
  const transcript = foldLiveText(run.transcript, chunk, view.runs);
  if (transcript === null) return false;
  if (transcript !== run.transcript) setRun(view, { ...run, transcript });
  return true;
}

// ---------------------------------------------------------------------------
// Durable events
// ---------------------------------------------------------------------------

/** A tool-use fact on a run whose arm cannot hold it is a publisher defect,
 *  made loud at the fold's boundary. */
function wrongArm(run: RunView, name: string): never {
  throw new Error(
    `${name} names ${run.id}, a ${run.category} run; the fact belongs to the ${AgentCategory.ToolUse} arm`,
  );
}

/** A durable event `runRows.ts` does not own. */
type OwnEvent = Exclude<DisplaySessionEvent, SharedRunRow>;

/** The event's own arm applied to its run (topology, session slices and the
 *  transcript tier are the caller's). */
function applyOwnArm(run: RunView, event: OwnEvent): RunView {
  switch (event.type) {
    case 'log':
    case 'stage.start':
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
    case 'run.start':
    case 'approval.policy':
    case 'inquiryThreadUpdated':
    case 'run.removed':
      // Existence cannot become more true (5.2, "Duplicates"): a second
      // start is a no-op. The rest move session slices alone.
      return run;
    case 'run.activate': {
      // Every activation, the launch and each resume, opens a running
      // window (one run model, 3.3): the phase, the run window and a fresh
      // incarnation's progress fold from it. A first activation is starting
      // and a later one resuming (A9-1); the first `flow.step` clears it.
      let substate: RunView['substate'] = null;
      if (isPlainAgentIdentity(run.identity)) {
        substate =
          run.status === RUN_LIFECYCLE_READY
            ? RUN_SUBSTATE.STARTING
            : RUN_SUBSTATE.RESUMING;
      }
      return {
        ...run,
        status: RUN_PHASE.RUNNING,
        substate,
        runStartedAt: event.at,
        flow: null,
        conversationProgress: { toolCallCount: 0 },
      };
    }
    case 'run.config': {
      // A background process has no model: its `run.config` is the
      // fabricated `AgentConfig` that feeds the live wire, whose `model` is
      // the schema's prefault. Every other identity carries the model its
      // launch routed, so it is shown.
      const model = run.identity.kind === 'process' ? null : event.config.model;
      return {
        ...run,
        model,
        modelLabel: model === null ? null : getModelLabel(model),
        command:
          run.identity.kind === 'process' ? event.config.instruction : null,
        inputFiles: event.config.inputFiles,
      };
    }
    case 'conversation.progress':
      return { ...run, conversationProgress: event.progress };
    case 'usage':
      // A latest-only listing key, so a cold read delivers one row per run,
      // and that row is the run's cumulative total from its single reporter
      // (`UsageMonitor`, or the agent-CLI loop for its own child run). The
      // newest row replaces the total; summing would double-count every
      // earlier round an aggregate replay brings on top of the listing row.
      // The one-element sum normalizes the extended payload down to the
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
    case 'run.fact': {
      // Every family is a latest-only listing key of its own, so a cold
      // read delivers one row per family and each row carries the run's
      // whole value: the newest row replaces what the view holds.
      const fact = event.fact;
      if (run.category !== AgentCategory.ToolUse)
        return wrongArm(run, `run.fact ${fact.key}`);
      return fact.key === 'todos'
        ? { ...run, todos: fact.todos }
        : { ...run, plan: fact.plan };
    }
    case 'goalStateChanged':
      return run.category === AgentCategory.ToolUse
        ? { ...run, goal: event.state }
        : wrongArm(run, 'goalStateChanged');
    case 'child.park':
      // An agent-CLI child's park, on the row the child protocol owns.
      // `flow` stays null: a run with no ledger has no position to paint.
      return parked(run, phaseMoveOf(event) === RUN_PHASE.WAITING, event.at);
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
  }
}

/** The run's loop position, projected from the slice the rows folded
 *  (one run model, 3.3), moved to the phase {@link phaseMoveOf} names. */
function withPosition(run: RunView, rows: RunRows, row: SharedRunRow) {
  const { family, step, round, turn, continuationIndex } = rows;
  if (family === null || step === null) return run;
  const flow = { family, step, round, turn, continuationIndex };
  const phase = phaseMoveOf(row);
  return phase === null
    ? { ...run, flow }
    : parked({ ...run, flow }, phase === RUN_PHASE.WAITING, row.at);
}

/** The run window (3.3): a park closes it and settles the transcript, any
 *  other move opens it. The one phase writer for both rows that park, a
 *  loop's `flow.step waiting` and a child's `child.park`. */
function parked(run: RunView, atRest: boolean, at: number): RunView {
  const moved: RunView = {
    ...run,
    status: atRest ? RUN_PHASE.WAITING : RUN_PHASE.RUNNING,
    substate: null,
    runStartedAt: atRest ? null : (run.runStartedAt ?? at),
  };
  return atRest ? withSettledTranscript(moved, at) : moved;
}

/** Session-level slices, applied before the run arm so the arm's aggregates
 *  see them. */
function applySessionSlices(
  view: SessionView,
  runId: RunId | null,
  event: DisplaySessionEvent,
): void {
  switch (event.type) {
    case 'run.start':
      // The initial snapshot rides the existence fact (PRD 6, item 2).
      // `runLifecycle.ts` always stamps it; the trace viewer's synthetic
      // envelope carries none, which is why the field stays optional.
      if (event.approvalPolicy && runId !== null) {
        writableMap(view, 'policy').set(runId, event.approvalPolicy);
      }
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
    default:
      return;
  }
}

/** One shared row, applied by `runRows.ts` and projected onto the session's
 *  containers and the run. `unresolved` is the partial read, not a defect: a
 *  cold listing delivers one request row per run, so the opening a decision
 *  answers may never have reached this view. A replayed row is below the
 *  pair's `latest` entry and never reaches here. */
function applyRowFacts(
  view: SessionView,
  run: RunView,
  event: SharedRunRow,
): RunView {
  const { rows } = sessionIndexesOf(view);
  const before = rows.get(run.id) ?? freshRunRows();
  const verdict = applyRunRow(before, event);
  if (verdict.kind === 'contradiction') {
    throw new Error(`${event.type} on ${run.id}: ${verdict.detail}`);
  }
  if (verdict.kind !== 'applied') return run;
  const moved = verdict.rows;
  const after: RunRows = { ...before, ...moved };
  rows.set(run.id, after);
  if (moved.requests !== undefined) projectRequests(view, run.id, after);
  if (moved.followUps !== undefined) projectFollowUps(view, run.id, after);
  const next = moved.step === undefined ? run : withPosition(run, after, event);
  const rounds = moved.roundOutputs;
  if (rounds === undefined) return next;
  const byRound = <T>(pick: (round: RoundOutput) => T) =>
    Object.fromEntries(rounds.map((r) => [r.round, pick(r)]));
  const files = nonEmptyRounds(byRound((r) => r.outputs));
  return {
    ...next,
    ...(run.category === AgentCategory.Workflow
      ? { files }
      : { outputs: files }),
    compileFailures: nonEmptyRounds(byRound((r) => r.compileFailures)),
    missingOutputs: byRound((r) => r.missingOutputs),
  };
}

/** `view.requests` is every run's open requests, in the order the rows
 *  opened them (5.2): this run's rebuilt from its slice, every other run's
 *  left where they are. Identity is (runId, requestId), so the dedupe of
 *  already-listed requests is scoped to this run, never another's. */
function projectRequests(view: SessionView, runId: RunId, rows: RunRows) {
  const open = Object.entries(rows.requests).filter(([, r]) => !r.resolved);
  const ids = new Set(open.map(([requestId]) => requestId));
  const kept = view.requests.filter(
    (r) => r.runId !== runId || ids.has(r.requestId),
  );
  view.requests = [
    ...kept,
    ...open.flatMap(([requestId, r]) =>
      kept.some((q) => q.runId === runId && q.requestId === requestId)
        ? []
        : [{ runId, requestId, payload: r.payload, thread: r.thread }],
    ),
  ];
}

/** The run's untaken input, as the view shows it. A map that never held
 *  this run is left alone: a delete that removes nothing must not copy. */
function projectFollowUps(view: SessionView, runId: RunId, rows: RunRows) {
  if (rows.followUps.length === 0) {
    if (view.queuedFollowUps.has(runId)) {
      writableMap(view, 'queuedFollowUps').delete(runId);
    }
    return;
  }
  writableMap(view, 'queuedFollowUps').set(
    runId,
    rows.followUps.map((f) => ({
      followUpId: f.followUpId,
      text: f.content.displayText ?? f.content.text,
    })),
  );
}

/** Move `run` from `previousParentId` to its current parent. A parent the
 *  view has no `run.start` for re-roots the run: top level, no ancestors. */
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

/** The run a durable event names: its aggregate, bar an inquiry's thread. */
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
  const traceChanged =
    read !== 'listing' &&
    (isTranscriptEvent(event) || phaseMoveOf(event) !== null)
      ? foldTraceEvent(view, event, deferred)
      : false;
  const listingType = listingKeyOf(event);
  if (listingType === null) return traceChanged;
  // Listing facts are ordered by commit per (aggregate, listing type),
  // whichever read delivered them (5.2, "Duplicates").
  const listingKey = `${event.aggregateId}/${listingType}`;
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

  // The rows both folds read are applied once, in `runRows.ts`; every other
  // row is the session's own.
  let own: RunView;
  if (isSharedRunRow(event)) {
    own = applyRowFacts(view, before, event);
  } else {
    applySessionSlices(view, runId, event);
    own = applyOwnArm(before, event);
  }
  if (event.type === 'run.end') {
    // The run ended; a terminal phase ends every live row (5.2, "In-flight
    // text": a run can end with a row unfinalized).
    sessionIndexesOf(view).ended.add(runId);
    clearLiveText(own.transcript);
  }
  // A fresh incarnation can end again.
  if (event.type === 'run.activate') {
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
  const statusMoved = own.status !== before.status;
  const aggregated = statusMoved
    ? withAggregates(view, withTranscriptFacts(next))
    : withAggregates(view, next);
  // The run model's own inputs: the run's existence and status.
  const runInputsMoved = created || statusMoved;
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

/** The transcript context a run folds under. */
function transcriptContextOf(
  view: SessionView,
  run: RunView,
): TranscriptContext {
  return {
    debug: view.debug,
    lifecycleToTaskGroups: lifecycleToTaskGroups(run),
    runLabels: view.runs,
  };
}

/** One trace or lifecycle row onto a resident run's transcript. */
function foldTraceEvent(
  view: SessionView,
  event: DisplaySessionEvent,
  deferred: DeferredRunModels,
): boolean {
  const retained = view.folded.get(event.aggregateId);
  if (retained === undefined || event.seq <= retained) return false;
  const runId = runIdOf(event.aggregateId);
  const run = runId === null ? undefined : view.runs.get(runId);
  if (!run) return false;
  const transcript = foldTranscriptEvent(
    run.transcript,
    event,
    transcriptContextOf(view, run),
  );
  writableMap(view, 'folded').set(event.aggregateId, event.seq);
  // A filtered fact still advances its source cursor. Keep the run and
  // transcript references stable when that fact produced no presentation.
  if (transcript === run.transcript) return true;
  setRun(
    view,
    runModelAt(
      view,
      withTranscriptFacts({ ...run, transcript, lastTimestamp: event.at }),
      deferred,
    ),
  );
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
  clearLiveText(run.transcript);
  // A map that never held this run is left alone: a delete that removes
  // nothing must not copy the map it publishes.
  if (view.policy.has(run.id)) writableMap(view, 'policy').delete(run.id);
  if (view.queuedFollowUps.has(run.id)) {
    writableMap(view, 'queuedFollowUps').delete(run.id);
  }
  sessionIndexesOf(view).rows.delete(run.id);
  writableMap(view, 'folded').delete(qualifyAggregateId('run', run.id));
  if (view.requests.some((r) => r.runId === run.id)) {
    view.requests = view.requests.filter((r) => r.runId !== run.id);
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
    clearLiveText(run.transcript);
    const evicted = withTranscriptFacts({
      ...run,
      transcript: emptyTranscript(),
    });
    setRun(view, runModelAt(view, evicted, deferred));
  }
}
