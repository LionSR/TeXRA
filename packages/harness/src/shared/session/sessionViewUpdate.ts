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

import { Equal, type Types, absurd } from 'effect';
import {
  aggregateTarget,
  qualifyAggregateId,
  MESSAGE_TYPES,
  recipeBlockOf,
  isPlainAgentIdentity,
  listingKeyOf,
  isTranscriptEvent,
  blocksCaller,
  runIdentityDisplayName,
  emptyUsageStats,
  sumUsageStats,
  type AggregateId,
  type SessionViewInput,
  type ExistenceReconciliation,
  type LocalRuntimeState,
  type UnreadableRun,
  type DisplayRow,
  type RunId,
  type TextChunk,
  type TranscriptSubscription,
  factName,
} from '@shared/schemas';
import { getModelLabel } from '@shared/model/modelLabel';
import { roundedUtilizationPercent } from '@shared/runs/contextUtilization';
import { compareByNewestCreationTime } from '@shared/runs/runOrdering';
import { isSettledRow, rowHeadline } from '../transcript/transcriptRow';
import {
  applyRunRow,
  freshSharedRunRows,
  isSharedRunRow,
  isMessage,
  type SharedRunRow,
} from './runRows';
import { standingAfter, type RunStanding } from './runRowReads';
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
import {
  emptySessionView,
  isInterrupted,
  requireRun,
  rollupOf,
} from './sessionView';
import type { SharedRunRows } from './runRowsShape';
import type { SessionView, RunView, TranscriptView } from './sessionView';

type RunStartEvent = Extract<DisplayRow, { type: 'run.start' }>;

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

/** An updater over session `key`'s empty, quiet view; a `debug` input
 *  changes its transcript verbosity. */
export function makeSessionViewUpdater(key: string): SessionViewUpdater {
  let view = emptySessionView(key);
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
          next = emptySessionView(next.key, each.enabled);
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
 * Existence comes from the database's sequence records (carried by the
 * `drained` and `replay.complete` markers), not from who wrote the rows. A
 * checked aggregate with no record no longer exists. The runs the same
 * read found this build cannot open are recorded and re-derived.
 */
function reconcileExistence(
  u: Update,
  existence: ExistenceReconciliation,
): void {
  for (const { runId, reason } of existence.unreadable) {
    if (u.state.unreadable.get(runId) === reason) continue;
    u.state.unreadable.set(runId, reason);
    if (u.view.runs.has(runId)) walkUp(u, runId);
  }
  const present = new Set(existence.present);
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

/** The session's run counts, kept as they were when unchanged: those
 *  interrupted, those waiting on the user here, and the others held here. */
function countGroups(view: ViewDraft): void {
  const rollup = { running: 0, waiting: 0, interrupted: 0 };
  for (const run of view.runs.values()) {
    if (isInterrupted(run)) rollup.interrupted += 1;
    else if (run.approval === 'own') rollup.waiting += 1;
    else if (run.holder === 'here') rollup.running += 1;
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
  readonly rows: Map<RunId, SharedRunRows>;
  /** One entry per `${aggregate}/${listing type}`: the commit of the newest
   *  listing fact applied for it, so an older one a later read replays is
   *  skipped. The lifecycle entry outlives its run: it keeps a replayed
   *  `run.start` from bringing a removed run back. */
  readonly latest: Map<string, number>;
  /** Each run's transcript working state (`transcriptState.ts`). */
  readonly transcripts: Map<RunId, TranscriptIndexes>;
  /** The runs this build cannot open, and why (`ExistenceReconciliation`). */
  readonly unreadable: Map<RunId, UnreadableRun['reason']>;
  /** The runs whose current turn is over ({@link turnIsOver}) as last
   *  derived, so a change finishes their transcript once. */
  readonly turnOver: Set<RunId>;
  /** The latest local runtime snapshot. */
  local: LocalRuntimeState;
}

function emptySessionState(): SessionState {
  return {
    listed: new Set(),
    rows: new Map(),
    latest: new Map(),
    transcripts: new Map(),
    unreadable: new Map(),
    turnOver: new Set(),
    local: { runsHere: [] },
  };
}

/** The view one `apply` call builds: a fresh envelope, written field by field. */
type ViewDraft = Types.Mutable<SessionView>;

/** One input's work. */
interface Update {
  /** The view being built: a fresh envelope whose containers are shared
   *  with the previous view until written. */
  readonly view: ViewDraft;
  readonly state: SessionState;
  /** The containers this `apply` call created, written in place. Any other
   *  belongs to a view already returned and is copied on its first write. */
  readonly owned: WeakSet<object>;
}

/** `map` if this call created it, else a copy this call owns, which the
 *  caller stores back. */
function writable<K, V>(u: Update, map: ReadonlyMap<K, V>): Map<K, V> {
  // cast: a map in `owned` is this call's own copy; no published view holds it.
  if (u.owned.has(map)) return map as Map<K, V>;
  const copy = new Map(map);
  u.owned.add(copy);
  return copy;
}

/** `map` without `key`; a map that never held the key is not copied. */
function without<K, V>(u: Update, map: ReadonlyMap<K, V>, key: K) {
  if (!map.has(key)) return map;
  const copy = writable(u, map);
  copy.delete(key);
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
    position: 'ready' as const,
    outcome: null,
    holder: 'none' as const,
    output: null,
    statusNotice: null,
    lost: null,
    createdAt: event.commit,
    launchedAt: event.at,
    turnStartedAt: null,
    runStartedAt: null,
    lastTimestamp: event.at,
    turn: null,
    takesFollowUps: event.takesFollowUps,
    context: null,
    parentId: event.parent?.id ?? null,
    launchParentId: event.parent?.id ?? null,
    forkedFrom:
      event.provenance?.kind === 'fork'
        ? { id: event.provenance.from.id, at: event.provenance.at }
        : null,
    forkPoint: null,
    parentCard: event.parent?.call?.card ?? null,
    ancestors: [],
    childIds: [],
    rollup: { total: 0, running: 0, finished: 0 },
    approval: 'none' as const,
    actions: [],
    usage: emptyUsageStats(),
    treeUsage: emptyUsageStats(),
    thinkingActive: false,
    compactingActive: false,
    latestLine: null,
    transcript: emptyTranscript(),
  };
  return { ...common, recipe: null };
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
  const chain: RunView['ancestors'][number][] = [];
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
 * Whether a run's current turn is over: it waits between turns, has ended,
 * or nobody holds it any more. Its transcript rows are then final:
 * `settledRows` covers them and nothing reads as thinking or compacting.
 */
const turnIsOver = (run: RunView): boolean =>
  run.holder === 'none' || run.position === 'waiting';

/**
 * A run's derived fields (holder, approval, clock, rollup, tree usage,
 * actions, notice), from its facts, the local snapshot and its children. A
 * run held here until its end is `here`; one that has not ended and that no
 * launch here holds is interrupted, pending request or not. A run waits on
 * the user only while a launch here has a request that blocks its tool;
 * unheld, nothing listens for the answer, and the request stays listed so a
 * resume can ask again. When its turn comes to be over, the transcript
 * facts follow.
 */
function withAggregates(u: Update, run: RunView): RunView {
  const { view } = u;
  const holder: RunView['holder'] =
    run.outcome === null && u.state.local.runsHere.includes(run.id)
      ? 'here'
      : 'none';
  // Only a request that blocks its tool is a wait: one that does not left
  // its run working, listed for the panel but still Running.
  const waiting =
    holder === 'here' &&
    view.requests.some((r) => r.runId === run.id && blocksCaller(r.payload));
  const unreadable = u.state.unreadable.get(run.id);
  const children = run.childIds.map((id) => requireRun(view, id));
  const treeUsage = sumUsageStats([
    run.usage,
    ...children.map((child) => child.treeUsage),
  ]);
  let approval: RunView['approval'] = 'none';
  if (waiting) approval = 'own';
  else if (children.some((child) => child.approval !== 'none'))
    approval = 'descendant';
  let statusNotice: RunView['statusNotice'] = null;
  if (unreadable !== undefined) statusNotice = { kind: unreadable };
  else if (run.lost !== null)
    statusNotice = { kind: 'lost', message: run.lost };
  const facts = { ...run, holder };
  const next = withDerived(run, {
    holder,
    approval,
    actions: runActions(facts, unreadable !== undefined),
    runStartedAt:
      holder === 'here' && run.position === 'running' && !waiting
        ? run.turnStartedAt
        : null,
    rollup: rollupOf(children),
    treeUsage,
    statusNotice,
  });
  const turnOver = turnIsOver(next);
  if (turnOver === u.state.turnOver.has(run.id)) return next;
  if (turnOver) u.state.turnOver.add(run.id);
  else u.state.turnOver.delete(run.id);
  // A turn its rows ended finished its compactions at the transcript's
  // boundary; one whose holder went away has written no such row.
  const transcript = turnOver
    ? finishOpenCompactions(
        next.transcript,
        transcriptWork(u, next.id),
        next.lastTimestamp,
      )
    : next.transcript;
  return withTranscriptFacts(
    u,
    transcript === next.transcript ? next : { ...next, transcript },
  );
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
 * frontier is walked. A run whose turn is over settles every open row
 * except a compaction block, which cleanup can still replace.
 */
function advanceSettledRows(
  rows: TranscriptView['rows'],
  start: number,
  turnOver: boolean,
): number {
  let index = Math.min(start, rows.length);
  while (index < rows.length) {
    const row = rows[index];
    if (!isSettledRow(row, index < rows.length - 1)) {
      // Bridge cleanup can still replace a planned/running compaction after
      // a cancellation, so it settles only on its own typed terminal state,
      // never on the final stream status.
      if (row.kind === 'compactionActivity' || !turnOver) break;
    }
    index += 1;
  }
  return index;
}

/** The transcript-derived fields of a run, after its rows moved or its turn
 *  started or ended: `settledRows`, `thinkingActive`, `compactingActive`,
 *  and `latestLine`. Once the turn is over nothing streams or compacts. */
function withTranscriptFacts(u: Update, run: RunView): RunView {
  const { transcript } = run;
  const turnOver = u.state.turnOver.has(run.id);
  const settledRows = advanceSettledRows(
    transcript.rows,
    transcript.settledRows,
    turnOver,
  );
  const activity = transcriptActivity(transcript, transcriptWork(u, run.id).ix);
  const thinkingActive = !turnOver && activity.thinkingActive;
  const compactingActive = !turnOver && activity.compactingActive;
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
type OwnEvent = Exclude<DisplayRow, SharedRunRow | { type: 'usage' }>;

/** What the event changes on its own run (topology, session-level fields and
 *  the transcript are the caller's). */
function applyRunEvent(run: RunView, event: OwnEvent): RunView {
  switch (event.type) {
    case 'log':
    case 'process.output':
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
    case 'run.stop':
      // `applyEvent` creates and removes the run; the rest change the
      // transcript or session-level fields, and a stop's interruption
      // reaches the view as the end it leads to.
      return run;
    case 'run.activate':
      // Every activation (the launch, a resume, a follow-up) sets the run
      // running, which clears its outcome; the tool-call count is the run's
      // and carries over. Its turn's clock starts here: an interrupted
      // run's old start would count the time nothing ran it.
      return {
        ...applyStanding(
          { ...run, turnStartedAt: null },
          standingOf(event),
          event.at,
        ),
        turn: null,
        lost: null,
        output: null,
      };
    case 'run.config': {
      // A process has no model; any other run is on its newest config's.
      const { config } = event;
      const kept = config.model ?? run.model;
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
    case 'plugin.fact':
      return {
        ...run,
        facts: { ...run.facts, [factName(event)]: event.value },
      };
    case 'run.detach': // the attached parent goes; the launch parent stays
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
      // The run ended: its outcome and output, and any result its end lost.
      return {
        ...applyStanding(run, standingOf(event), event.at),
        output: event.output,
        ...(event.error?.kind === 'result-lost'
          ? { lost: event.error.message }
          : {}),
      };
  }
}

/** The run's loop position, read from what `runRows.ts` recorded, moved to
 *  where {@link standingAfter} leaves it. */
function withPosition(run: RunView, rows: SharedRunRows, row: SharedRunRow) {
  if (rows.family === null || rows.at === null) return run;
  if (row.type === 'run.position' && row.payload.at === 'waiting')
    run = { ...run, forkPoint: row.seq };
  const turn = rows.turn;
  const standing = standingAfter(row);
  return standing === null
    ? { ...run, turn }
    : applyStanding({ ...run, turn }, standing, row.at);
}

/** Where a lifecycle row leaves its run; only those rows reach here. */
function standingOf(row: Parameters<typeof standingAfter>[0]): RunStanding {
  const standing = standingAfter(row);
  if (standing === null) throw new Error(`${row.type} changes no run standing`);
  return standing;
}

/** Put the run where a lifecycle row leaves it: the one standing writer. Inside
 *  a turn its clock keeps the turn's start; out of one it clears. */
function applyStanding(
  run: RunView,
  standing: RunStanding,
  at: number,
): RunView {
  return {
    ...run,
    position: standing.position,
    outcome: standing.outcome,
    turnStartedAt:
      standing.position === 'running' ? (run.turnStartedAt ?? at) : null,
  };
}

/** The rows that change a session-level field; every other row changes
 *  only its run. */
type SessionFactRow = Extract<
  DisplayRow,
  { type: 'run.start' | 'approval.policy' | 'plugin.fact' }
>;
const changesSessionFacts = (event: DisplayRow): event is SessionFactRow =>
  event.type === 'run.start' ||
  event.type === 'approval.policy' ||
  event.type === 'plugin.fact';

/** The session-level fields an event changes, applied before the run's own
 *  change so its derived fields see them. */
function applySessionFacts(
  u: Update,
  runId: RunId | null,
  event: DisplayRow,
): void {
  if (!changesSessionFacts(event)) return;
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
      absurd(event);
  }
}

/** One shared row, applied by `runRows.ts` and projected onto the session's
 *  containers and the run. `unresolved` is the partial read, not a defect: a
 *  cold listing delivers one request row per run, so the opening a decision
 *  answers may never have reached this view. A replayed row is below its
 *  `latest` entry and never reaches here. */
function applyRowFacts(u: Update, run: RunView, event: SharedRunRow): RunView {
  const { rows } = u.state;
  const before = rows.get(run.id) ?? freshSharedRunRows();
  const verdict = applyRunRow(before, event);
  if (verdict.kind === 'contradiction') {
    throw new Error(`${event.type} on ${run.id}: ${verdict.detail}`);
  }
  if (verdict.kind !== 'applied') return run;
  const moved = verdict.rows;
  const after: SharedRunRows = { ...before, ...moved };
  rows.set(run.id, after);
  if (moved.requests !== undefined) projectRequests(u.view, run.id, after);
  if (moved.followUps !== undefined) projectFollowUps(u, run.id, after);
  return moved.at === undefined ? run : withPosition(run, after, event);
}

/** `view.requests` is every run's open requests, in the order the rows
 *  opened them: this run's rebuilt from its rows, every other run's left
 *  where they are. Identity is (runId, requestId), so the dedupe of
 *  already-listed requests is scoped to this run, never another's. */
function projectRequests(view: ViewDraft, runId: RunId, rows: SharedRunRows) {
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
function projectFollowUps(u: Update, runId: RunId, rows: SharedRunRows) {
  const { view } = u;
  const messages = rows.followUps.filter(isMessage);
  if (messages.length === 0) {
    view.queuedFollowUps = without(u, view.queuedFollowUps, runId);
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
  event: DisplayRow,
  read: 'listing' | 'aggregate' | 'all',
): boolean {
  const transcriptChanged =
    read !== 'listing' &&
    (isTranscriptEvent(event) || standingAfter(event) !== null)
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
  let before: RunView;
  if (known) before = known;
  else if (event.type === 'run.start') before = createRun(u, event, runId);
  else return false;
  latest.set(listingKey, event.commit);
  if (event.type === 'run.removed') return removeRun(u, runId);
  const created = !known;

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
    own = applyRunEvent(before, event);
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
  const linked = u.view.runs.get(next.id);
  if (!linked) throw new Error(`Run ${next.id} left the view while relinking`);
  next = linked;
  setRun(u, withAggregates(u, next));
  walkUp(u, next.parentId);
  return true;
}

/** One transcript or lifecycle row onto a subscribed run's transcript. */
function applyTranscriptRow(u: Update, event: DisplayRow): boolean {
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
      lifecycleStages: isPlainAgentIdentity(run.identity),
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
  view.runs = without(u, view.runs, run.id);
  view.policy = without(u, view.policy, run.id);
  view.queuedFollowUps = without(u, view.queuedFollowUps, run.id);
  state.rows.delete(run.id);
  state.transcripts.delete(run.id);
  state.turnOver.delete(run.id);
  const aggregateId = qualifyAggregateId('run', run.id);
  view.transcriptSeq = without(u, view.transcriptSeq, aggregateId);
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
    setRun(u, { ...requireRun(view, childId), parentId: null });
    view.order = insertOrdered(view, view.order, childId);
    refreshAncestors(u, childId);
  }
  return true;
}

/** A new local snapshot can change how any run reads (held here,
 *  interrupted, blocked, its turn over), so every run is re-derived;
 *  `withDerived` keeps an unchanged one as it was. The reader sends a
 *  snapshot only when it changed. */
function applyLocal(u: Update, local: LocalRuntimeState): void {
  u.state.local = local;
  for (const id of [...u.view.runs.keys()]) walkUp(u, id);
}

/**
 * The transcript subscription set: an aggregate entering it gets its
 * `transcriptSeq` entry at the seq the subscription names; one leaving it
 * loses its transcript (rows, stages, compactions, live text) and its
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
    view.transcriptSeq = without(u, view.transcriptSeq, id);
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
