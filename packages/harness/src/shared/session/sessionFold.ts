/**
 * The one fold (PRD one-fold-three-renderers, G1 and 5.2): `fold(view,
 * input)` turns the durable session events, live text chunks, the local
 * runtime snapshot, and the transcript subscription set into `SessionView`.
 * Every process that shows a session runs it; the transport carries its
 * input, never its output.
 *
 * Pure in the sense that matters: no IO, no clock, no platform, no store reads,
 * and the same input sequence yields the same view. Incremental in the sense
 * the PRD requires: an event recomputes the arm for its run, walks `parentId`
 * to the root refreshing each ancestor's `childIds`, `rollup`, `treeUsage`,
 * `approval`, `group`, and `forceExpanded`, then touches `order` only when a
 * top-level run appeared, moved, or left. O(depth) per event, never a whole-view pass. A text
 * chunk costs the chunk, never the row's text.
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
 * Publication (D5): returned views are immutable; untouched branches retain
 * identity. `writable` and the transcript fold copy each changed container
 * at most once per fold, and writes stop when fold returns. No-op writes keep
 * the previous branch. RunView, TranscriptView, and SessionView are replaced
 * on change, preserving older views and identity-based host comparisons.
 * Indexes are module-private, keyed by their transcript/view, and advance only
 * with the latest level: row/group positions, text and thinking state, claims,
 * listing commits, owners, ended/listed runs, snapshots, and shared-row slices.
 * So `fold` refuses any view but the level it last returned.
 * Every container write must report changed so foldWith publishes its copy.
 */

import {
  aggregateTarget,
  aggregateId as qualifyAggregateId,
  MESSAGE_TYPES,
  RUN_PHASE,
  RUN_LIFECYCLE_READY,
  RUN_SUBSTATE,
  isDocumentTaskConfig,
  isPlainAgentIdentity,
  listingKeyOf,
  isTranscriptEvent,
  ownerPid,
  requestParksItsCaller,
  runIdentityDisplayName,
  emptyUsageStats,
  sumUsageStats,
  type TokenUsageStats,
  type AggregateId,
  type FoldInput,
  type ExistenceReconciliation,
  type LocalRuntimeState,
  type DisplaySessionEvent,
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
  RUN_BLOCKED_COPY,
  runHeldMessage,
  runInterruptedMessage,
  runResumeBlockedMessage,
  runStatusCopy,
} from '@shared/runs/runStatusDisplay';
import { isSettledRow, rowHeadline, type TranscriptRow } from '../transcript';
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
  settleTranscript,
  transcriptActivity,
} from './transcriptReads';
import {
  emptyTranscript,
  lifecycleToTaskGroups,
  replaceTranscript,
  resetTranscriptOwnership,
} from './transcriptState';

import { runActions } from './runActions';
import { emptySessionView, rollupOf } from './sessionView';
import type { SessionView, RunView } from './sessionView';

type RunStartEvent = Extract<DisplaySessionEvent, { type: 'run.start' }>;

/** One input, or a frame of them (the transport's unit, 7.4 and 8.1) or a
 *  replay: every input in order. */
export function fold(
  view: SessionView,
  input: FoldInput | readonly FoldInput[],
): SessionView {
  const indexes = sessionIndexesOf(view);
  if (indexes.head !== null && indexes.head !== view) {
    throw new Error('Fold onto a superseded or failed SessionView level');
  }
  indexes.head = FOLD_FAILED;
  // One call publishes one level: nothing this call did not copy is written.
  owned = new WeakSet();
  resetTranscriptOwnership();
  let next = view;
  for (const each of '_tag' in input ? [input] : input) {
    next = foldWith(next, each);
  }
  // A `debug` input starts fresh indexes; the ones it left name `next` too.
  indexes.head = next;
  sessionIndexesOf(next).head = next;
  return next;
}

function foldWith(view: SessionView, input: FoldInput): SessionView {
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
      return foldDurable(next, input.event, input.read) ? next : view;
    }
    case 'chunk':
      return foldTextChunk(next, input) ? next : view;
    case 'local':
      foldLocal(next, input.local);
      return next;
    case 'subscriptions':
      foldSubscriptions(next, input.set);
      return next;
    case 'drained':
      reconcileExistence(next, input.existence);
      next.cursor = input.cursor;
      return next;
    case 'blocked': {
      const runId = runIdOf(input.aggregateId);
      const run = runId === null ? undefined : next.runs.get(runId);
      if (run === undefined || run.blocked !== null) return view;
      setRun(next, { ...run, blocked: input.reason });
      walkUp(next, run.id);
      return next;
    }
    case 'replay.complete': {
      // The input reader releases the completed replay as one batch (7.2). Its
      // marker closes the listing ahead of it: a run no listing row of this
      // sequence named is gone, tombstone and all, because retention pruned it
      // while this surface was away and no later read can deliver the deletion.
      const { listed } = sessionIndexesOf(next);
      for (const id of [...next.runs.keys()]) {
        if (!listed.has(qualifyAggregateId('run', id)))
          foldRunRemoved(next, id);
      }
      listed.clear();
      reconcileExistence(next, input.existence);
      return next;
    }
  }
}

/** Current sequence-row claims supersede historical writers and captured liveness inputs. */
function reconcileExistence(
  view: SessionView,
  existence: ExistenceReconciliation,
): void {
  const { claims } = sessionIndexesOf(view);
  for (const { aggregateId, ownerId } of existence.claims) {
    claims.set(aggregateId, ownerId);
    const target = aggregateTarget(aggregateId);
    if (target.kind !== 'run') continue;
    const run = view.runs.get(target.id);
    if (!run || run.ownerId === ownerId) continue;
    setRun(view, { ...run, ownerId });
    walkUp(view, run.id);
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
    if (target.kind === 'run') foldRunRemoved(view, target.id);
    if (view.pluginFacts.some((fact) => fact.aggregateId === id)) {
      view.pluginFacts = view.pluginFacts.filter(
        (fact) => fact.aggregateId !== id,
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
   *  `view.requests`, `view.queuedFollowUps`, `RunView.turn` and the run's
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
  /** The level these indexes describe: the view `fold` last returned, null
   *  before the first, `FOLD_FAILED` during a fold and after one threw. */
  head: SessionView | typeof FOLD_FAILED | null;
}

const FOLD_FAILED = Symbol('fold failed');

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
      local: { self: [], dead: [], unreadable: [], resumeBlocked: [] },
      head: null,
    };
    SESSION_INDEXES.set(view.runs, indexes);
  }
  return indexes;
}

// ---------------------------------------------------------------------------
// Copy on touch (D5): the containers this call owns
// ---------------------------------------------------------------------------

/** The maps and arrays this `fold` call created: written directly. Any other
 *  container belongs to a published level and is copied on its first write,
 *  into the envelope being built. Reset at `fold` entry, so a throw mid-fold
 *  cannot carry ownership into the next call. */
let owned = new WeakSet<object>();

/** `map` if this call owns it, else an owned copy the caller stores back. */
function writable<K, V>(map: Map<K, V>): Map<K, V> {
  if (owned.has(map)) return map;
  const copy = new Map(map);
  owned.add(copy);
  return copy;
}

/** `view.runs`, writable; a copy inherits the session's indexes. */
function writableRuns(view: SessionView): SessionView['runs'] {
  const runs = writable(view.runs);
  if (runs !== view.runs) SESSION_INDEXES.set(runs, sessionIndexesOf(view));
  view.runs = runs;
  return runs;
}

// ---------------------------------------------------------------------------
// Run construction
// ---------------------------------------------------------------------------

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
  const label = runIdentityDisplayName(identity);
  const common = {
    id,
    identity,
    ownerId: sessionIndexesOf(view).claims.get(event.aggregateId) ?? null,
    label,
    description: null,
    descriptionBy: null,
    title: label,
    model: null,
    modelLabel: null,
    command: null,
    inputFiles: [],
    facts: {},
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
    turn: null,
    followUpSupport: event.userFollowUpSupport,
    context: null,
    parentId: event.parent === null ? null : event.parent.id,
    forkedFrom:
      event.provenance?.kind === 'fork'
        ? { id: event.provenance.from.id, at: event.provenance.at }
        : null,
    forkPoint: null,
    parentCard: event.parentCard ?? null,
    ancestors: [],
    childIds: [],
    rollup: { total: 0, running: 0, finished: 0 },
    approval: 'none' as const,
    ownedHere: false,
    readOnly: false,
    blocked: null,
    resumeBlocked: null,
    actions: [],
    forceExpanded: false,
    group: 'recent' as const,
    usage: emptyUsageStats(),
    treeUsage: emptyUsageStats(),
    thinkingActive: false,
    compactingActive: false,
    latestLine: null,
    transcript: emptyTranscript(),
  };
  return { ...common, documentTask: false, plan: null };
}

/**
 * Land a run value in the index and keep the paper-level rollup (5.1)
 * current from the group it left and the group it entered. Every write to
 * `view.runs` goes through here; `dropRun` is the one removal.
 */
function setRun(view: SessionView, run: RunView): void {
  const previous = view.runs.get(run.id);
  writableRuns(view).set(run.id, run);
  if (previous?.ownerId !== run.ownerId) {
    reindexOwner(view, run.id, previous?.ownerId ?? null, run.ownerId);
  }
  if (previous?.group !== run.group)
    countGroups(view, previous?.group, run.group);
}

function dropRun(view: SessionView, run: RunView): void {
  writableRuns(view).delete(run.id);
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
 * `group`, `approval`, `readOnly`, `actions`, `forceExpanded`, `rollup`,
 * `treeUsage`, `durableOutcome` and the status copy, from the run's facts, the local
 * snapshot and its children (5.2). Interrupted is owner loss: a non-terminal
 * run nobody holds (this process, or one whose lease this one may not
 * touch), pending approval or not. Waiting needs a held owner and a request
 * that parks its tool; unheld, that request reads as interrupted, since
 * nothing listens for the answer, and stays listed so a resume can re-ask.
 */
function withAggregates(view: SessionView, run: RunView): RunView {
  const { local } = sessionIndexesOf(view);
  const owner = run.ownerId;
  const own = owner !== null && local.self.includes(owner);
  const heldBy =
    owner !== null && !own && !local.dead.includes(owner) ? owner : null;
  const heldElsewhere = heldBy !== null;
  const held = own || heldElsewhere;
  const paused = run.substate === RUN_SUBSTATE.PAUSED;
  // Only a request that parks its tool is a wait: a dispatched inquiry left
  // its run working, listed for the panel but still Running.
  const pendingOwn = view.requests.some(
    (r) => r.runId === run.id && requestParksItsCaller(r.payload),
  );
  const interrupted = !isTerminalOutcomePhase(run.status) && !held && !paused;
  const waiting = pendingOwn && held && !isTerminalOutcomePhase(run.status);
  const durableOutcome =
    isTerminalOutcomePhase(run.status) &&
    (!own || sessionIndexesOf(view).ended.has(run.id))
      ? run.status
      : null;
  const unreadable = run.blocked
    ? RUN_BLOCKED_COPY[run.blocked]
    : local.unreadable.find((u) => u.runId === run.id)?.detail;
  const children = run.childIds.flatMap((id) => view.runs.get(id) ?? []);
  const rollup = rollupOf(children);
  const treeUsage = sumUsageStats([
    run.usage,
    ...children.map((child) => child.treeUsage),
  ]);
  const descendantWaiting = children.some((child) => child.approval !== 'none');
  const descendantNeedsUser = children.some((child) => child.forceExpanded);
  let group: RunView['group'] = 'recent';
  if (interrupted) group = 'interrupted';
  else if (waiting) group = 'waiting';
  else if (isInFlightPhase(run.status) && !paused) group = 'running';
  let approval: RunView['approval'] = 'none';
  if (waiting) approval = 'own';
  else if (descendantWaiting) approval = 'descendant';
  const copy = runStatusCopy(run.status, {
    substate: run.substate ?? undefined,
    interrupted,
    waiting,
  });
  const readOnly = heldElsewhere || unreadable !== undefined;
  const actions = runActions({ ...run, readOnly, group });
  const forceExpanded = waiting || interrupted || descendantNeedsUser;
  const blockedEntry = local.resumeBlocked.find((b) => b.runId === run.id);
  const resumeBlocked = blockedEntry?.reason ?? null;
  let statusDetail: string | null = unreadable ?? null;
  if (statusDetail === null && blockedEntry !== undefined)
    statusDetail = runResumeBlockedMessage(
      blockedEntry.reason,
      blockedEntry.retry,
    );
  else if (statusDetail === null && interrupted)
    statusDetail = runInterruptedMessage();
  else if (statusDetail === null && heldBy !== null)
    statusDetail = runHeldMessage(ownerPid(heldBy));
  if (
    run.group === group &&
    run.approval === approval &&
    run.readOnly === readOnly &&
    run.actions.join() === actions.join() &&
    run.ownedHere === own &&
    run.forceExpanded === forceExpanded &&
    run.durableOutcome === durableOutcome &&
    run.rollup.total === rollup.total &&
    run.rollup.running === rollup.running &&
    run.rollup.finished === rollup.finished &&
    sameUsage(run.treeUsage, treeUsage) &&
    run.statusLabel === copy.statusLabel &&
    run.tone === copy.tone &&
    run.statusDetail === statusDetail &&
    run.resumeBlocked === resumeBlocked
  ) {
    return run;
  }
  return {
    ...run,
    group,
    approval,
    readOnly,
    actions,
    ownedHere: own,
    forceExpanded,
    durableOutcome,
    rollup,
    treeUsage,
    ...copy,
    statusDetail,
    resumeBlocked,
  };
}

function sameUsage(a: TokenUsageStats, b: TokenUsageStats): boolean {
  return (
    a.cost === b.cost &&
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.cacheReadInputTokens === b.cacheReadInputTokens &&
    a.cacheMissInputTokens === b.cacheMissInputTokens &&
    a.cacheCreationInputTokens === b.cacheCreationInputTokens &&
    a.reasoningTokens === b.reasoningTokens &&
    a.usageRoute === b.usageRoute &&
    a.usagePlan === b.usagePlan
  );
}

/** Re-derive the aggregates of `startId` and every ancestor above it. */
function walkUp(view: SessionView, startId: RunId | null): void {
  const seen = new Set<RunId>();
  let id = startId;
  while (id !== null && !seen.has(id)) {
    seen.add(id);
    const current = view.runs.get(id);
    if (!current) return;
    const next = withAggregates(view, current);
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

/** A run's newest operational summary, for one with no reply to show (a
 *  script's run, a document task): what its tool, phase, card, error, or
 *  plain log row last said. */
function operationalLatestLine(
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
 * kind whose state bridge cleanup can still replace (a compaction block).
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
      // Bridge cleanup can still replace a planned/running compaction after
      // a cancellation, so it settles only on its own typed terminal state,
      // never on the final stream status.
      if (row.kind === 'compactionActivity' || !runFinal) break;
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
    latestConversationLine(transcript.rows, settledRows) ??
    operationalLatestLine(transcript.rows) ??
    run.latestLine;
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

/** A durable event `runRows.ts` does not own, bar a priced turn. */
type OwnEvent = Exclude<DisplaySessionEvent, SharedRunRow | { type: 'usage' }>;

/** The event's own arm applied to its run (topology, session slices and the
 *  transcript tier are the caller's). */
function applyOwnArm(run: RunView, event: OwnEvent): RunView {
  switch (event.type) {
    case 'log':
    case 'stage.start':
    case 'stage.end':
    case 'tool.start':
    case 'tool.end':
    case 'stream.start':
    case 'stream.end':
    case 'response.finalized':
    case 'run.start':
    case 'approval.policy':
    case 'run.removed':
      // Existence cannot become more true (5.2); the rest move session slices.
      return run;
    case 'run.activate': {
      // Every activation, the launch and each resume, opens a running window
      // (one run model, 3.3); the tool-call count is the run's and carries
      // over. A first activation is starting and a later one resuming (A9-1);
      // the first `run.position` clears it.
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
        turn: null,
      };
    }
    case 'run.config': {
      // A process has no model; any other run keeps a `run.model` it holds.
      const { config } = event;
      const kept = run.model ?? config.model ?? null;
      const model = run.identity.kind === 'process' ? null : kept;
      return {
        ...run,
        model,
        modelLabel: model === null ? null : getModelLabel(model),
        command: run.identity.kind === 'process' ? config.instruction : null,
        inputFiles: 'inputFiles' in config ? config.inputFiles : [],
        documentTask: isDocumentTaskConfig(config),
      };
    }
    case 'run.model':
      return {
        ...run,
        model: event.model,
        modelLabel: getModelLabel(event.model),
      };
    case 'conversation.progress':
      return { ...run, conversationProgress: event.progress };
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
    case 'run.fact':
      // Each family (and `plugin.fact` kind) is its own latest-only key.
      return { ...run, plan: event.fact.plan };
    case 'plugin.fact':
      return {
        ...run,
        facts: { ...run.facts, [`${event.plugin}/${event.kind}`]: event.value },
      };
    case 'child.park':
      // A loop-driven child's park or pause; no run history, so `turn` stays null.
      return event.phase === 'paused'
        ? { ...parked(run, true, event.at), substate: RUN_SUBSTATE.PAUSED }
        : parked(run, phaseMoveOf(event) === RUN_PHASE.WAITING, event.at);
    case 'run.detach':
      // The edge severed (one run model, 3.2); a run never gets a new parent.
      return run.parentId === null ? run : { ...run, parentId: null };
    case 'run.description':
      // A user's title stands until the user renames again: the next AI
      // summary does not overwrite it.
      return event.by === 'model' && run.descriptionBy === 'user'
        ? run
        : {
            ...run,
            description: event.description,
            descriptionBy: event.by,
            title: event.description || run.label,
          };
    case 'run.end':
      // The terminal fact: the phase is its outcome (one run model, section
      // 3.3). The caller records that the run ended.
      return withSettledTranscript(
        { ...run, status: event.outcome, substate: null, runStartedAt: null },
        event.at,
      );
  }
}

/** The run's loop position, projected from the slice the rows folded
 *  (one run model, 3.3), moved to the phase {@link phaseMoveOf} names. */
function withPosition(run: RunView, rows: RunRows, row: SharedRunRow) {
  if (rows.family === null || rows.at === null) return run;
  if (
    row.type === 'run.position' &&
    (row.payload.at === 'waiting' || row.payload.at === 'halted')
  )
    run = { ...run, forkPoint: row.seq };
  const turn = rows.turn;
  const phase = phaseMoveOf(row);
  return phase === null
    ? { ...run, turn }
    : parked({ ...run, turn }, phase === RUN_PHASE.WAITING, row.at);
}

/** The run window (3.3): a park closes it and settles the transcript, any
 *  other move opens it. The one phase writer for both rows that park, a
 *  loop's `run.position waiting` and a child's `child.park`. */
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
        view.policy = writable(view.policy).set(runId, event.approvalPolicy);
      }
      return;
    case 'approval.policy':
      if (runId !== null)
        view.policy = writable(view.policy).set(runId, event.snapshot);
      return;
    case 'plugin.fact': {
      // A run's own rows fold onto the run (`applyOwnArm`).
      if (runId !== null) return;
      const { seq: _s, commit: _c, origin: _o, at: _a, ...fact } = event;
      const held = view.pluginFacts.findIndex(
        (old) =>
          old.aggregateId === fact.aggregateId &&
          old.plugin === fact.plugin &&
          old.kind === fact.kind,
      );
      view.pluginFacts =
        held === -1
          ? [...view.pluginFacts, fact]
          : view.pluginFacts.with(held, fact);
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
  return moved.at === undefined ? run : withPosition(run, after, event);
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

/** The run's untaken messages (not its own requests), as the view shows them. */
function projectFollowUps(view: SessionView, runId: RunId, rows: RunRows) {
  const messages = rows.followUps.filter((f) => f.control === undefined);
  if (messages.length === 0) {
    if (view.queuedFollowUps.has(runId)) {
      view.queuedFollowUps = writable(view.queuedFollowUps);
      view.queuedFollowUps.delete(runId);
    }
    return;
  }
  view.queuedFollowUps = writable(view.queuedFollowUps).set(
    runId,
    messages.map((f) => ({
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

/** Returns whether the event changed anything. */
function foldDurable(
  view: SessionView,
  event: DisplaySessionEvent,
  read: 'listing' | 'aggregate' | 'all',
): boolean {
  const traceChanged =
    read !== 'listing' &&
    (isTranscriptEvent(event) ||
      phaseMoveOf(event) !== null ||
      ['run.config', 'run.model'].includes(event.type))
      ? foldTraceEvent(view, event)
      : false;
  const listingType = listingKeyOf(event);
  if (listingType === null) return traceChanged;
  // Ordered by commit per (aggregate, listing type), whatever the read (5.2).
  const listingKey = `${event.aggregateId}/${listingType}`;
  const { latest } = sessionIndexesOf(view);
  const newest = latest.get(listingKey);
  if (newest !== undefined && event.commit <= newest) return traceChanged;

  // The run the event names: its aggregate, bar a plugin's own.
  const runId = runIdOf(event.aggregateId);
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
  if (event.type === 'run.removed') return foldRunRemoved(view, runId);
  const created = !known;
  const before = known ?? createRun(view, event as RunStartEvent, runId);

  // The rows both folds read are applied once, in `runRows.ts`; every other
  // row is the session's own.
  let own: RunView;
  if (isSharedRunRow(event)) {
    own = applyRowFacts(view, before, event);
  } else if (event.type === 'usage') {
    // The listing's row is the run's spend through its commit; every other
    // read's row is one priced turn. `latest` above is the run's high-water
    // commit, so a turn one read already counted never counts twice.
    own = {
      ...before,
      usage:
        read === 'listing'
          ? event.usage
          : sumUsageStats([before.usage, event.usage]),
    };
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
  if (event.type === 'run.activate') sessionIndexesOf(view).ended.delete(runId);
  let next: RunView = { ...own, lastTimestamp: event.at };
  setRun(view, next);

  if (created || next.parentId !== before.parentId) {
    relink(view, next, created ? null : before.parentId);
    if (!created) walkUp(view, before.parentId);
  }
  if (next.label !== before.label)
    for (const childId of next.childIds) refreshAncestors(view, childId);
  next = view.runs.get(next.id)!;
  const statusMoved = own.status !== before.status;
  const aggregated = statusMoved
    ? withAggregates(view, withTranscriptFacts(next))
    : withAggregates(view, next);
  setRun(view, aggregated);
  walkUp(view, next.parentId);
  return true;
}

/** One trace or lifecycle row onto a resident run's transcript. */
function foldTraceEvent(
  view: SessionView,
  event: DisplaySessionEvent,
): boolean {
  const retained = view.folded.get(event.aggregateId);
  if (retained === undefined || event.seq <= retained) return false;
  const runId = runIdOf(event.aggregateId);
  const run = runId === null ? undefined : view.runs.get(runId);
  if (!run) return false;
  const transcript = foldTranscriptEvent(run.transcript, event, {
    debug: view.debug,
    lifecycleToTaskGroups: lifecycleToTaskGroups(run),
    runLabels: view.runs,
  });
  view.folded = writable(view.folded).set(event.aggregateId, event.seq);
  // A filtered fact still advances its source cursor. Keep the run and
  // transcript references stable when that fact produced no presentation.
  if (transcript === run.transcript) return true;
  setRun(
    view,
    withTranscriptFacts({ ...run, transcript, lastTimestamp: event.at }),
  );
  return true;
}

/**
 * The tombstone (5.2, "Existence" and "Durable text wins"): final, clears every
 * session-level entry keyed by the run, re-roots its children, and ends its
 * transcript tier. The run's `latest` entries stay: the lifecycle one is what
 * outranks a replayed `run.start` beneath the tombstone.
 */
function foldRunRemoved(view: SessionView, runId: RunId): boolean {
  const run = view.runs.get(runId);
  if (!run) return false;
  dropRun(view, run);
  clearLiveText(run.transcript);
  // A map that never held this run is left alone: a delete that removes
  // nothing must not copy the map it publishes.
  if (view.policy.has(run.id)) {
    view.policy = writable(view.policy);
    view.policy.delete(run.id);
  }
  if (view.queuedFollowUps.has(run.id)) {
    view.queuedFollowUps = writable(view.queuedFollowUps);
    view.queuedFollowUps.delete(run.id);
  }
  sessionIndexesOf(view).rows.delete(run.id);
  view.folded = writable(view.folded);
  view.folded.delete(qualifyAggregateId('run', run.id));
  if (view.requests.some((r) => r.runId === run.id)) {
    view.requests = view.requests.filter((r) => r.runId !== run.id);
  }
  if (view.pluginFacts.some((fact) => fact.parent === run.id)) {
    view.pluginFacts = view.pluginFacts.filter(
      (fact) => fact.parent !== run.id,
    );
  }
  view.order = withoutId(view.order, run.id);
  const parent =
    run.parentId === null ? undefined : view.runs.get(run.parentId);
  if (parent) {
    setRun(view, {
      ...parent,
      childIds: withoutId(parent.childIds, run.id),
    });
    walkUp(view, parent.id);
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
function foldLocal(view: SessionView, local: LocalRuntimeState): void {
  const indexes = sessionIndexesOf(view);
  const previous = indexes.local;
  indexes.local = local;
  // An owner entering or leaving the held set, or moving between self and a
  // proved-dead verdict, changes the answer for every run it holds.
  const standing = (state: LocalRuntimeState, owner: string) =>
    state.self.includes(owner) ? 'self' : state.dead.includes(owner);
  const changedOwners = new Set(
    [...previous.self, ...previous.dead, ...local.self, ...local.dead].filter(
      (owner) => standing(previous, owner) !== standing(local, owner),
    ),
  );
  const touched = new Set<RunId>();
  for (const owner of changedOwners) {
    for (const runId of indexes.byOwner.get(owner) ?? []) {
      touched.add(runId);
    }
  }
  const details = (state: LocalRuntimeState) =>
    new Map(state.unreadable.map((u) => [u.runId, u.detail]));
  const [before, after] = [details(previous), details(local)];
  for (const runId of new Set([...before.keys(), ...after.keys()]))
    if (before.get(runId) !== after.get(runId)) touched.add(runId);
  const blockers = (state: LocalRuntimeState) =>
    new Map(state.resumeBlocked.map((b) => [b.runId, b]));
  const [held, holding] = [blockers(previous), blockers(local)];
  for (const runId of new Set([...held.keys(), ...holding.keys()]))
    if (held.get(runId) !== holding.get(runId)) touched.add(runId);
  for (const runId of touched) walkUp(view, runId);
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
): void {
  const subscribed = new Map(set.map((s) => [s.id, s.fromSeq]));
  for (const [id, fromSeq] of subscribed) {
    if (!view.folded.has(id))
      view.folded = writable(view.folded).set(id, fromSeq);
  }
  for (const id of [...view.folded.keys()]) {
    if (subscribed.has(id)) continue;
    view.folded = writable(view.folded);
    view.folded.delete(id);
    const target = aggregateTarget(id);
    const run = target.kind === 'run' ? view.runs.get(target.id) : undefined;
    if (!run) continue;
    clearLiveText(run.transcript);
    const evicted = withTranscriptFacts({
      ...run,
      transcript: emptyTranscript(),
    });
    setRun(view, evicted);
  }
}
