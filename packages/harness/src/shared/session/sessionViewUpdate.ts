/**
 * Applies session events, live text chunks, the local runtime state and the
 * transcript subscriptions to a session's `SessionView`. Every process that
 * shows a session runs it; the transport carries the inputs, never the view.
 *
 * - Skips a listing fact (a row the cold listing also serves) older than one
 *   already applied for that run and type, whichever read delivered it.
 * - Builds transcripts only for open runs (those in the subscription set),
 *   and applies a transcript row only when its seq is past the last one
 *   applied for that run (`view.transcriptSeq`).
 * - A run exists from its `run.start` until its `run.removed`; a fact naming
 *   any other run changes nothing.
 * - After a full re-read (`replay.complete`), drops the runs the listing
 *   didn't mention.
 * - Never mutates a returned view. Copies only what changes, once per
 *   `apply` call, so unchanged objects stay `===` and a host can compare a
 *   view with the previous one by identity.
 *
 * An event re-derives its run and each ancestor up to the root; a text chunk
 * costs the chunk, never the row's text.
 */

import { Equal } from 'effect';
import {
  aggregateTarget,
  qualifyAggregateId,
  MESSAGE_TYPES,
  RUN_PHASE,
  RUN_LIFECYCLE_READY,
  RESTING_SUBSTATES,
  RUN_SUBSTATE,
  parkSubstate,
  recipeBlockOf,
  isPlainAgentIdentity,
  listingKeyOf,
  isTranscriptEvent,
  ownerPid,
  requestParksItsCaller,
  runIdentityDisplayName,
  emptyUsageStats,
  sumUsageStats,
  type AggregateId,
  type SessionViewInput,
  type ExistenceReconciliation,
  type LocalRuntimeState,
  type DisplaySessionEvent,
  type RunEnd,
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
import { runStatus } from '@shared/runs/runStatusDisplay';
import { isSettledRow, rowHeadline } from '../transcript/transcriptRow';
import {
  applyRunRow,
  freshRunRows,
  isSharedRunRow,
  pendingMessages,
  phaseMoveOf,
  type RunRows,
  type SharedRunRow,
} from './runRows';
import { applyTranscriptEvent } from './transcriptUpdate';
import {
  applyLiveText,
  clearLiveText,
  finishOpenCompactions,
  transcriptActivity,
} from './transcriptReads';
import {
  emptyTranscript,
  emptyTranscriptIndexes,
  type TranscriptIndexes,
  type TranscriptWork,
} from './transcriptState';

import { runActions } from './runActions';
import { emptySessionView, rollupOf } from './sessionView';
import type { SessionView, RunView, TranscriptView } from './sessionView';

type RunStartEvent = Extract<DisplaySessionEvent, { type: 'run.start' }>;

/** One session's view, and the state its updates keep beside it. */
export interface SessionViewUpdater {
  /** The view after every input applied so far. */
  readonly current: () => SessionView;
  /**
   * Apply one input, or a batch in order, and return the new view: the
   * previous one when nothing changed. A throw leaves the updater's state
   * partly advanced, so its owner discards it.
   */
  readonly apply: (
    input: SessionViewInput | readonly SessionViewInput[],
  ) => SessionView;
}

/** An updater over session `key`'s empty view at `cursor`, with transcript
 *  verbosity `debug`. */
export function makeSessionViewUpdater(
  key: string,
  cursor = 0,
  debug = false,
): SessionViewUpdater {
  let view = emptySessionView(key, cursor, debug);
  let state = emptySessionState();
  return {
    current: () => view,
    apply: (input) => {
      const owned = new WeakSet<object>();
      let next = view;
      for (const each of '_tag' in input ? [input] : input) {
        if (each._tag === 'debug') {
          // A new verbosity rebuilds the view from the replay that follows.
          if (next.debug === each.enabled) continue;
          next = emptySessionView(next.key, 0, each.enabled);
          state = emptySessionState();
          continue;
        }
        // Each input writes a fresh envelope, kept only when it changed
        // something.
        const u: Update = { view: { ...next }, state, owned };
        if (applyInput(u, each)) next = u.view;
      }
      if (next.runs !== view.runs) countGroups(next);
      view = next;
      return next;
    },
  };
}

function applyInput(
  u: Update,
  input: Exclude<SessionViewInput, { _tag: 'debug' }>,
): boolean {
  switch (input._tag) {
    case 'event':
      if (input.read === 'listing') {
        u.state.listed.add(input.event.aggregateId);
      }
      return applyEvent(u, input.event, input.read);
    case 'chunk':
      return applyTextChunk(u, input);
    case 'local':
      applyLocal(u, input.local);
      return true;
    case 'subscriptions':
      applySubscriptions(u, input.set);
      return true;
    case 'drained':
      reconcileExistence(u, input.existence);
      u.view.cursor = input.cursor;
      return true;
    case 'replay.complete': {
      // The input reader delivers a full re-read as one batch ending here. A
      // run the listing ahead of this marker didn't mention was deleted by
      // retention while this view was away, and no later read delivers that
      // deletion.
      for (const id of [...u.view.runs.keys()]) {
        if (!u.state.listed.has(qualifyAggregateId('run', id))) {
          removeRun(u, id);
        }
      }
      u.state.listed.clear();
      reconcileExistence(u, input.existence);
      return true;
    }
  }
}

/**
 * Run owners come from the database's live ownership records (each
 * aggregate's claim, carried by the `drained` and `replay.complete`
 * markers), not from who wrote the rows. A checked aggregate with no record
 * no longer exists.
 */
function reconcileExistence(
  u: Update,
  existence: ExistenceReconciliation,
): void {
  for (const { aggregateId, ownerId } of existence.claims) {
    const runId = runIdOf(aggregateId);
    const run = runId === null ? undefined : u.view.runs.get(runId);
    if (!run || run.ownerId === ownerId) continue;
    setRun(u, { ...run, ownerId });
    walkUp(u, run.id);
  }
  const present = new Set(
    existence.claims.map(({ aggregateId }) => aggregateId),
  );
  for (const id of existence.checkedAggregateIds) {
    if (present.has(id)) continue;
    // The reader reports an aggregate with no record as absent whether it
    // was removed or has not started yet: a subscription can name a run
    // before its `run.start` commits. So only a run the view holds goes; the
    // subscription's `transcriptSeq` entry stays, or the run's first rows
    // would be dropped.
    const runId = runIdOf(id);
    if (runId !== null) removeRun(u, runId);
    if (u.view.pluginFacts.some((fact) => fact.aggregateId === id)) {
      u.view.pluginFacts = u.view.pluginFacts.filter(
        (fact) => fact.aggregateId !== id,
      );
    }
  }
}

/** The session's run counts by group, kept as they were when unchanged. */
function countGroups(view: SessionView): void {
  const rollup = { running: 0, waiting: 0, interrupted: 0 };
  for (const run of view.runs.values()) {
    if (run.group !== 'recent') rollup[run.group] += 1;
  }
  if (!Equal.equals(rollup, view.rollup)) view.rollup = rollup;
}

// ---------------------------------------------------------------------------
// State kept beside the view
// ---------------------------------------------------------------------------

/** What one session's updates keep beside its view, never on it. */
interface SessionState {
  /** The aggregates the listing named since the last `replay.complete`. */
  readonly listed: Set<AggregateId>;
  /** What the rows `runRows.ts` reads say about each run: `view.requests`,
   *  `view.queuedFollowUps` and `RunView.turn` are built from it. */
  readonly rows: Map<RunId, RunRows>;
  /** One entry per `${aggregate}/${listing type}`: the commit of the newest
   *  listing fact applied for it, so an older one a later read replays is
   *  skipped. The lifecycle entry outlives its run: it keeps a replayed
   *  `run.start` from bringing a removed run back. */
  readonly latest: Map<string, number>;
  /** Each run's transcript working state (`transcriptState.ts`). */
  readonly transcripts: Map<RunId, TranscriptIndexes>;
  /** The latest local runtime snapshot. */
  local: LocalRuntimeState;
}

function emptySessionState(): SessionState {
  return {
    listed: new Set(),
    rows: new Map(),
    latest: new Map(),
    transcripts: new Map(),
    local: { self: [], dead: [], unreadable: [], resumeBlocked: [] },
  };
}

/** One input's work. */
interface Update {
  /** The view being built: a fresh envelope whose containers are shared
   *  with the previous view until written. */
  readonly view: SessionView;
  readonly state: SessionState;
  /** The containers this `apply` call created, written in place. Any other
   *  belongs to a view already returned and is copied on its first write. */
  readonly owned: WeakSet<object>;
}

/** `map` if this call created it, else a copy this call owns, which the
 *  caller stores back. */
function writable<K, V>(u: Update, map: Map<K, V>): Map<K, V> {
  if (u.owned.has(map)) return map;
  const copy = new Map(map);
  u.owned.add(copy);
  return copy;
}

/** Store a run value. Every write to `view.runs` goes through here, bar the
 *  delete in `removeRun`. */
function setRun(u: Update, run: RunView): void {
  u.view.runs = writable(u, u.view.runs).set(run.id, run);
}

/** The run's transcript working state, with the arrays this call owns. */
function transcriptWork(u: Update, runId: RunId): TranscriptWork {
  const ix = u.state.transcripts.get(runId);
  if (!ix) throw new Error(`Run ${runId} has no transcript state`);
  return { ix, owned: u.owned };
}

// ---------------------------------------------------------------------------
// Run construction
// ---------------------------------------------------------------------------

/** The run a run-aggregate event names; null for any other aggregate kind. */
function runIdOf(aggregateId: AggregateId): RunId | null {
  const target = aggregateTarget(aggregateId);
  return target.kind === 'run' ? target.id : null;
}

/** A run in its initial shape, created by its `run.start` alone. Its owner
 *  comes from the existence marker that ends the same batch. */
function createRun(u: Update, event: RunStartEvent, id: RunId): RunView {
  u.state.transcripts.set(id, emptyTranscriptIndexes());
  const label = runIdentityDisplayName(event.identity);
  const common = {
    id,
    identity: event.identity,
    ownerId: null,
    label,
    description: null,
    descriptionBy: null,
    title: label,
    model: null,
    modelLabel: null,
    command: null,
    inputFiles: [],
    agentScope: null,
    facts: {},
    worktree: event.worktree ?? null,
    status: RUN_LIFECYCLE_READY,
    substate: null,
    durableOutcome: null,
    statusNotice: null,
    lost: null,
    ...runStatus(RUN_LIFECYCLE_READY),
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
  return { ...common, recipe: null, plan: null };
}

// ---------------------------------------------------------------------------
// Ordering and topology
// ---------------------------------------------------------------------------

/** `ids` with `id` placed by the `runOrdering` rule. */
function insertOrdered(
  view: SessionView,
  ids: readonly RunId[],
  id: RunId,
): RunId[] {
  const next = withoutId(ids, id);
  const run = view.runs.get(id);
  if (!run) return next;
  const at = next.findIndex((otherId) => {
    const other = view.runs.get(otherId);
    return other !== undefined && compareByNewestCreationTime(run, other) < 0;
  });
  next.splice(at < 0 ? next.length : at, 0, id);
  return next;
}

function withoutId(ids: readonly RunId[], id: RunId): RunId[] {
  return ids.filter((existing) => existing !== id);
}

/** Root first. A parent edge always names a run the view holds: `relink`
 *  makes a run whose parent the view lacks top-level. */
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

/** Recompute `ancestors` for a run and its descendants (a moved subtree).
 *  O(subtree), once per such change. */
function refreshAncestors(u: Update, runId: RunId): void {
  const run = u.view.runs.get(runId);
  if (!run) return;
  const next = withDerived(run, { ancestors: ancestorsOf(u.view, run) });
  if (next !== run) setRun(u, next);
  for (const childId of run.childIds) refreshAncestors(u, childId);
}

// ---------------------------------------------------------------------------
// Derived per-run facts
// ---------------------------------------------------------------------------

/**
 * A run's derived fields (group, approval, status copy, rollup, tree usage,
 * actions, notice), from its facts, the local snapshot and its children. A
 * run that has not ended and that nobody holds is interrupted, pending
 * request or not. A run waits only while a held owner has a request that
 * blocks its tool; unheld, it reads as interrupted, since nothing listens
 * for the answer, and the request stays listed so a resume can ask again.
 */
function withAggregates(u: Update, run: RunView): RunView {
  const { view } = u;
  const { local } = u.state;
  const owner = run.ownerId;
  const own = owner !== null && local.self.includes(owner);
  const heldBy =
    owner !== null && !own && !local.dead.includes(owner) ? owner : null;
  const held = own || heldBy !== null;
  const paused = RESTING_SUBSTATES.has(run.substate);
  // Only a request that blocks its tool is a wait: a dispatched inquiry left
  // its run working, listed for the panel but still Running.
  const pendingOwn = view.requests.some(
    (r) => r.runId === run.id && requestParksItsCaller(r.payload),
  );
  const interrupted = !isTerminalOutcomePhase(run.status) && !held && !paused;
  const waiting = pendingOwn && held && !isTerminalOutcomePhase(run.status);
  const durableOutcome = isTerminalOutcomePhase(run.status) ? run.status : null;
  const unreadable = local.unreadable.find(
    (entry) => entry.runId === run.id,
  )?.reason;
  const children = run.childIds.flatMap((id) => view.runs.get(id) ?? []);
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
  const status = runStatus(run.status, {
    substate: run.substate ?? undefined,
    interrupted,
    waiting,
  });
  const stranded = heldBy === null && unreadable !== undefined;
  const readOnly = heldBy !== null || stranded;
  const actions = runActions({ ...run, readOnly, group }, stranded);
  const forceExpanded = waiting || interrupted || descendantNeedsUser;
  const blockedEntry = local.resumeBlocked.find((b) => b.runId === run.id);
  const resumeBlocked = blockedEntry?.reason ?? null;
  let statusNotice: RunView['statusNotice'] = null;
  if (unreadable !== undefined) statusNotice = { kind: unreadable };
  else if (blockedEntry !== undefined)
    statusNotice = {
      kind: 'resumeBlocked',
      reason: blockedEntry.reason,
      retry: blockedEntry.retry,
    };
  else if (interrupted) statusNotice = { kind: 'interrupted' };
  else if (heldBy !== null)
    statusNotice = { kind: 'held', pid: ownerPid(heldBy) };
  else if (run.lost !== null)
    statusNotice = { kind: 'lost', message: run.lost };
  return withDerived(run, {
    group,
    approval,
    readOnly,
    actions,
    ownedHere: own,
    forceExpanded,
    durableOutcome,
    rollup: rollupOf(children),
    treeUsage,
    ...status,
    statusNotice,
    resumeBlocked,
  });
}

/**
 * `run` with its `derived` fields, or `run` itself when every one is
 * structurally unchanged. Derived values are built fresh and never mutated,
 * so `Equal.equals` caching their hashes is safe; a mutable value (the
 * transcript, which live text edits in place) never goes through here.
 */
function withDerived(run: RunView, derived: Partial<RunView>): RunView {
  return Object.entries(derived).every(([key, value]) =>
    Equal.equals(Reflect.get(run, key), value),
  )
    ? run
    : { ...run, ...derived };
}

/** Re-derive the fields of `startId` and every ancestor above it. */
function walkUp(u: Update, startId: RunId | null): void {
  let id = startId;
  while (id !== null) {
    const current = u.view.runs.get(id);
    if (!current) return;
    const next = withAggregates(u, current);
    if (next !== current) setRun(u, next);
    id = current.parentId;
  }
}

/** Once the run waits or has ended, finish the compactions its transcript
 *  still shows open; record a result its end lost. */
function withTurnFinished(
  u: Update,
  run: RunView,
  at: number,
  e?: RunEnd['error'],
): RunView {
  if (e?.kind === 'result-lost')
    run = { ...run, lost: e.message ?? 'Result lost' };
  if (!isTranscriptSettlementPhase(run.status)) return run;
  const transcript = finishOpenCompactions(
    run.transcript,
    transcriptWork(u, run.id),
    at,
  );
  return transcript === run.transcript ? run : { ...run, transcript };
}

// ---------------------------------------------------------------------------
// Run facts read from the transcript (here, never by a host)
// ---------------------------------------------------------------------------

function nonEmpty(text: string | undefined): string | undefined {
  return text !== undefined && text.trim().length > 0 ? text : undefined;
}

/** A run's newest operational summary, for one with no reply to show (a
 *  script's run, a task's recipe): what its tool, card, error, or
 *  plain log row last said. */
function operationalLatestLine(
  rows: TranscriptView['rows'],
): string | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row.kind === 'tool') {
      const line =
        nonEmpty(row.toolUse.headerSummary) ?? nonEmpty(row.model.headerLabel);
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
  rows: TranscriptView['rows'],
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
 * Advance `settledRows`, the contiguous leading prefix of settled rows: an
 * append-only scrollback prints rows in order, so a row is settled for
 * printing only once every row before it is. Only the tail past the previous
 * frontier is walked. A finished run settles every open row except a
 * compaction block, which cleanup can still replace.
 */
function advanceSettledRows(
  rows: TranscriptView['rows'],
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

/** The transcript-derived fields of a run, after its rows or its phase
 *  moved: `settledRows`, `thinkingActive`, `compactingActive`, and
 *  `latestLine`. */
function withTranscriptFacts(u: Update, run: RunView): RunView {
  const { transcript } = run;
  const runFinal = isTranscriptSettlementPhase(run.status);
  const settledRows = advanceSettledRows(
    transcript.rows,
    transcript.settledRows,
    runFinal,
  );
  const { thinkingActive, compactingActive } = transcriptActivity(
    transcript,
    transcriptWork(u, run.id).ix,
  );
  const latestLine =
    latestConversationLine(transcript.rows, settledRows) ??
    operationalLatestLine(transcript.rows) ??
    run.latestLine;
  const next = withDerived(run, {
    thinkingActive,
    compactingActive,
    latestLine,
  });
  return settledRows === transcript.settledRows
    ? next
    : { ...next, transcript: { ...transcript, settledRows } };
}

/** Apply one live chunk to its run's transcript; a chunk for a run the view
 *  does not hold is dropped. Returns whether the chunk changed anything. */
function applyTextChunk(u: Update, chunk: TextChunk): boolean {
  const run = u.view.runs.get(chunk.runId);
  if (!run) return false;
  const transcript = applyLiveText(
    run.transcript,
    transcriptWork(u, run.id),
    chunk,
    u.view.runs,
  );
  if (transcript === null) return false;
  if (transcript !== run.transcript) setRun(u, { ...run, transcript });
  return true;
}

// ---------------------------------------------------------------------------
// Durable events
// ---------------------------------------------------------------------------

/** A durable event `runRows.ts` does not handle, other than a priced turn. */
type OwnEvent = Exclude<DisplaySessionEvent, SharedRunRow | { type: 'usage' }>;

/** What the event changes on its own run (topology, session-level fields and
 *  the transcript are the caller's). */
function applyRunEvent(u: Update, run: RunView, event: OwnEvent): RunView {
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
      // `applyEvent` creates and removes the run; the rest change the
      // transcript or session-level fields.
      return run;
    case 'run.activate': {
      // Every activation (the launch, a resume, a follow-up) sets the run
      // running, which clears its terminal outcome; the tool-call count is
      // the run's and carries over. A first activation is starting and a
      // later one resuming; the first `run.position` clears that.
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
        lost: null,
      };
    }
    case 'run.config': {
      // A process has no model; any other run is on its newest config's.
      const { config } = event;
      const kept = config.model ?? run.model ?? null;
      const model = run.identity.kind === 'process' ? null : kept;
      return {
        ...run,
        model,
        modelLabel: model === null ? null : getModelLabel(model),
        command: run.identity.kind === 'process' ? config.instruction : null,
        inputFiles: 'inputFiles' in config ? config.inputFiles : [],
        agentScope: { delegationAgentScope: null, ...config }
          .delegationAgentScope,
        recipe: recipeBlockOf(config),
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
      run = movePhase(u, run, event.phase !== 'resumed', event.at);
      return { ...run, substate: parkSubstate(event) };
    case 'run.detach':
      // The parent edge is cut; a run never gets a new parent.
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
      // The run ended: its outcome, and any result its end lost.
      return withTurnFinished(
        u,
        { ...run, status: event.outcome, substate: null, runStartedAt: null },
        event.at,
        event.error,
      );
  }
}

/** The run's loop position, read from what `runRows.ts` recorded, moved to
 *  the phase {@link phaseMoveOf} names. */
function withPosition(
  u: Update,
  run: RunView,
  rows: RunRows,
  row: SharedRunRow,
) {
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
    : movePhase(u, { ...run, turn }, phase === RUN_PHASE.WAITING, row.at);
}

/** Set the run waiting (its turn is over: `runStartedAt` clears and the
 *  transcript's open compactions finish) or running. The one phase writer
 *  for both rows that make a run wait: a loop's `run.position` at `waiting`
 *  and an agent-CLI child's `child.park`. */
function movePhase(
  u: Update,
  run: RunView,
  waiting: boolean,
  at: number,
): RunView {
  const moved: RunView = {
    ...run,
    status: waiting ? RUN_PHASE.WAITING : RUN_PHASE.RUNNING,
    substate: null,
    runStartedAt: waiting ? null : (run.runStartedAt ?? at),
  };
  return waiting ? withTurnFinished(u, moved, at) : moved;
}

/** The session-level fields an event changes, applied before the run's own
 *  change so its derived fields see them. */
function applySessionFacts(
  u: Update,
  runId: RunId | null,
  event: DisplaySessionEvent,
): void {
  const { view } = u;
  switch (event.type) {
    case 'run.start':
      // The run's initial policy snapshot comes with its `run.start`.
      // `runLifecycle.ts` always stamps it; the trace viewer's synthetic
      // envelope carries none, which is why the field stays optional.
      if (event.approvalPolicy && runId !== null) {
        view.policy = writable(u, view.policy).set(runId, event.approvalPolicy);
      }
      return;
    case 'approval.policy':
      if (runId !== null)
        view.policy = writable(u, view.policy).set(runId, event.snapshot);
      return;
    case 'plugin.fact': {
      // A run's own plugin facts go on the run (`applyRunEvent`).
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
 *  answers may never have reached this view. A replayed row is below its
 *  `latest` entry and never reaches here. */
function applyRowFacts(u: Update, run: RunView, event: SharedRunRow): RunView {
  const { rows } = u.state;
  const before = rows.get(run.id) ?? freshRunRows();
  const verdict = applyRunRow(before, event);
  if (verdict.kind === 'contradiction') {
    throw new Error(`${event.type} on ${run.id}: ${verdict.detail}`);
  }
  if (verdict.kind !== 'applied') return run;
  const moved = verdict.rows;
  const after: RunRows = { ...before, ...moved };
  rows.set(run.id, after);
  if (moved.requests !== undefined) projectRequests(u.view, run.id, after);
  if (moved.followUps !== undefined) projectFollowUps(u, run.id, after);
  return moved.at === undefined ? run : withPosition(u, run, after, event);
}

/** `view.requests` is every run's open requests, in the order the rows
 *  opened them: this run's rebuilt from its rows, every other run's left
 *  where they are. Identity is (runId, requestId), so the dedupe of
 *  already-listed requests is scoped to this run, never another's. */
function projectRequests(view: SessionView, runId: RunId, rows: RunRows) {
  const open = Object.entries(rows.requests).filter(([, r]) => !r.decision);
  const ids = new Set(open.map(([requestId]) => requestId));
  const kept = view.requests.filter(
    (r) => r.runId !== runId || ids.has(r.requestId),
  );
  view.requests = [
    ...kept,
    ...open.flatMap(([requestId, r]) =>
      kept.some((q) => q.runId === runId && q.requestId === requestId)
        ? []
        : [{ runId, requestId, payload: r.payload }],
    ),
  ];
}

/** The run's untaken messages (not its own requests), as the view shows them. */
function projectFollowUps(u: Update, runId: RunId, rows: RunRows) {
  const { view } = u;
  const messages = pendingMessages(rows.followUps, (id) => view.runs.get(id));
  if (messages.length === 0) {
    if (!view.queuedFollowUps.has(runId)) return;
    view.queuedFollowUps = writable(u, view.queuedFollowUps);
    view.queuedFollowUps.delete(runId);
    return;
  }
  view.queuedFollowUps = writable(u, view.queuedFollowUps).set(
    runId,
    messages.map((f) => ({
      followUpId: f.followUpId,
      text: f.content.displayText ?? f.content.text,
    })),
  );
}

/**
 * Move `run` from `previousParentId` to its current parent. A run whose
 * parent the view has no `run.start` for becomes top-level, as does one that
 * names itself as its parent: the database refuses that row, but a trace
 * file can carry one, and every reader walks the tree. Those are the only
 * ways to a cycle: a parent is set only on the run's creation, before
 * anything can name the run as its parent, and is only ever cleared after.
 */
function relink(u: Update, run: RunView, previousParentId: RunId | null): void {
  const { view } = u;
  const previousParent =
    previousParentId === null ? undefined : view.runs.get(previousParentId);
  if (previousParent) {
    setRun(u, {
      ...previousParent,
      childIds: withoutId(previousParent.childIds, run.id),
    });
  }
  const parent =
    run.parentId === null || run.parentId === run.id
      ? undefined
      : view.runs.get(run.parentId);
  if (!parent && run.parentId !== null) setRun(u, { ...run, parentId: null });
  if (parent) {
    setRun(u, {
      ...parent,
      childIds: insertOrdered(view, parent.childIds, run.id),
    });
  }
  const inOrder = view.order.includes(run.id);
  if (!parent && !inOrder) {
    view.order = insertOrdered(view, view.order, run.id);
  }
  if (parent && inOrder) view.order = withoutId(view.order, run.id);
  refreshAncestors(u, run.id);
}

/** Apply one durable event. Returns whether it changed anything. */
function applyEvent(
  u: Update,
  event: DisplaySessionEvent,
  read: 'listing' | 'aggregate' | 'all',
): boolean {
  const transcriptChanged =
    read !== 'listing' &&
    (isTranscriptEvent(event) || phaseMoveOf(event) !== null)
      ? applyTranscriptRow(u, event)
      : false;
  const listingType = listingKeyOf(event);
  if (listingType === null) return transcriptChanged;
  // Ordered by commit per (aggregate, listing type), whatever the read.
  const listingKey = `${event.aggregateId}/${listingType}`;
  const { latest } = u.state;
  const newest = latest.get(listingKey);
  if (newest !== undefined && event.commit <= newest) return transcriptChanged;

  // The run the event names: its aggregate, unless that is a plugin's own.
  const runId = runIdOf(event.aggregateId);
  if (runId === null) {
    latest.set(listingKey, event.commit);
    applySessionFacts(u, null, event);
    return true;
  }
  const known = u.view.runs.get(runId);
  // Only `run.start` creates a run, once. A fact for a run without one
  // changes nothing and leaves no entry (its publisher logs it).
  if (!known && event.type !== 'run.start') return false;
  latest.set(listingKey, event.commit);
  if (event.type === 'run.removed') return removeRun(u, runId);
  const created = !known;
  const before = known ?? createRun(u, event as RunStartEvent, runId);

  // The rows the run loop's state is also built from are applied once, in
  // `runRows.ts`; every other row is the view's own.
  let own: RunView;
  if (isSharedRunRow(event)) {
    own = applyRowFacts(u, before, event);
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
    applySessionFacts(u, runId, event);
    own = applyRunEvent(u, before, event);
  }
  if (event.type === 'run.end') {
    // A run can end with a row unfinalized: its end drops all live text.
    clearLiveText(transcriptWork(u, runId).ix);
  }
  // Reads arrive in any order: older history never moves the clock back.
  const lastTimestamp = Math.max(own.lastTimestamp, event.at);
  let next: RunView = { ...own, lastTimestamp };
  setRun(u, next);

  if (created || next.parentId !== before.parentId) {
    relink(u, next, created ? null : before.parentId);
    if (!created) walkUp(u, before.parentId);
  }
  next = u.view.runs.get(next.id)!;
  const statusMoved = own.status !== before.status;
  const aggregated = statusMoved
    ? withAggregates(u, withTranscriptFacts(u, next))
    : withAggregates(u, next);
  setRun(u, aggregated);
  walkUp(u, next.parentId);
  return true;
}

/** One transcript or lifecycle row onto a subscribed run's transcript. */
function applyTranscriptRow(u: Update, event: DisplaySessionEvent): boolean {
  const applied = u.view.transcriptSeq.get(event.aggregateId);
  if (applied === undefined || event.seq <= applied) return false;
  const runId = runIdOf(event.aggregateId);
  const run = runId === null ? undefined : u.view.runs.get(runId);
  if (!run) return false;
  const transcript = applyTranscriptEvent(
    run.transcript,
    transcriptWork(u, run.id),
    event,
    {
      debug: u.view.debug,
      lifecycleToTaskGroups: isPlainAgentIdentity(run.identity),
      runLabels: u.view.runs,
    },
  );
  u.view.transcriptSeq = writable(u, u.view.transcriptSeq).set(
    event.aggregateId,
    event.seq,
  );
  // A filtered row still advances the run's seq. Keep the run and transcript
  // references stable when that row showed nothing.
  if (transcript === run.transcript) return true;
  const lastTimestamp = Math.max(run.lastTimestamp, event.at);
  setRun(u, withTranscriptFacts(u, { ...run, transcript, lastTimestamp }));
  return true;
}

/**
 * Remove a run (its `run.removed`, or a re-read that no longer finds it):
 * every session-level entry keyed by it goes, with its transcript and its
 * working state, and its children become top-level. Its `latest` entries
 * stay: the lifecycle one keeps a replayed `run.start` from bringing it back.
 */
function removeRun(u: Update, runId: RunId): boolean {
  const { view, state } = u;
  const run = view.runs.get(runId);
  if (!run) return false;
  view.runs = writable(u, view.runs);
  view.runs.delete(run.id);
  // A map that never held this run is left alone: a delete that removes
  // nothing must not copy the map it publishes.
  if (view.policy.has(run.id)) {
    view.policy = writable(u, view.policy);
    view.policy.delete(run.id);
  }
  if (view.queuedFollowUps.has(run.id)) {
    view.queuedFollowUps = writable(u, view.queuedFollowUps);
    view.queuedFollowUps.delete(run.id);
  }
  state.rows.delete(run.id);
  state.transcripts.delete(run.id);
  view.transcriptSeq = writable(u, view.transcriptSeq);
  view.transcriptSeq.delete(qualifyAggregateId('run', run.id));
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
    setRun(u, {
      ...parent,
      childIds: withoutId(parent.childIds, run.id),
    });
    walkUp(u, parent.id);
  }
  // A child whose parent is gone is top-level: no dangling edge, no
  // ancestors.
  for (const childId of run.childIds) {
    const child = view.runs.get(childId);
    if (!child) continue;
    setRun(u, { ...child, parentId: null });
    view.order = insertOrdered(view, view.order, childId);
    refreshAncestors(u, childId);
  }
  return true;
}

/** A new local snapshot can change how any run reads (held here or
 *  elsewhere, interrupted, unreadable, blocked), so every run is re-derived;
 *  `withDerived` keeps an unchanged one as it was. The reader sends a
 *  snapshot only when it changed. */
function applyLocal(u: Update, local: LocalRuntimeState): void {
  u.state.local = local;
  for (const id of [...u.view.runs.keys()]) walkUp(u, id);
}

/**
 * The transcript subscription set: an aggregate entering it gets its
 * `transcriptSeq` entry at the seq the subscription names; one leaving it
 * loses its transcript (rows, task groups, compactions, live text) and its
 * entry, keeping every listing fact.
 */
function applySubscriptions(
  u: Update,
  set: readonly TranscriptSubscription[],
): void {
  const { view } = u;
  const subscribed = new Map(set.map((s) => [s.id, s.fromSeq]));
  for (const [id, fromSeq] of subscribed) {
    if (!view.transcriptSeq.has(id))
      view.transcriptSeq = writable(u, view.transcriptSeq).set(id, fromSeq);
  }
  for (const id of [...view.transcriptSeq.keys()]) {
    if (subscribed.has(id)) continue;
    view.transcriptSeq = writable(u, view.transcriptSeq);
    view.transcriptSeq.delete(id);
    const runId = runIdOf(id);
    const run = runId === null ? undefined : view.runs.get(runId);
    if (!run) continue;
    u.state.transcripts.set(run.id, emptyTranscriptIndexes());
    setRun(
      u,
      withTranscriptFacts(u, { ...run, transcript: emptyTranscript() }),
    );
  }
}
