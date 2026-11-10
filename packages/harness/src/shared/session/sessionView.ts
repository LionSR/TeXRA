/**
 * The one session state every renderer reads (`sessionViewUpdate.ts`), never
 * persisted, never parsed: a field lands here first and every host reads it.
 *
 * `SessionView` holds `Map`s because it never crosses a bridge; only events,
 * chunks, and `local` do, and those are arrays and records.
 *
 * Interaction state (selection, drafts, recording, expansion, focus, scroll)
 * is never here.
 */
import { Schema } from 'effect';

import { ApprovalPolicySnapshotSchema } from '@shared/approvalBypassKind';
import {
  AggregateIdSchema,
  AnsweredBySchema,
  CommitOrdinalSchema,
  ContextStateDataSchema,
  JsonValueSchema,
  RequestPayloadSchema,
  PluginFactDraftSchema,
  blocksCaller,
  RunActionSchema,
  RunEndSchema,
  RunIdentitySchema,
  RunNoticeSchema,
  RunOutcomeSchema,
  RunPositionSchema,
  RunIdSchema,
  StageSchema,
  TokenUsageStatsSchema,
  WorktreeInfoSchema,
  type RequestPayload,
  type RunId,
  FactNameSchema,
} from '@shared/schemas';
import type { TranscriptRow } from '@shared/transcript/transcriptRow';
import type {
  RunView as ReadRunView,
  SessionView as ReadSessionView,
} from './readonlyViews';

/** Which session (project) a view is of: the session's storage root. */
const SessionKeySchema = Schema.String.check(Schema.isMinLength(1));

/** The integer fields' shapes: `Count` from zero, `Positive` from one. */
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Positive = Schema.Int.check(Schema.isGreaterThan(0));

/**
 * A run's transcript slice: what hosts paint, and nothing else. The updater
 * keeps the run's working state (row and group positions, the compaction
 * projection's state, the live text per streaming row) beside the view,
 * never on it (`transcriptState.ts`), so a host can neither depend on nor
 * mutate it. The slice is replaced on every change and never written after
 * the update that produced it returns. Row and block elements are the shared
 * renderers' own TypeScript shapes, stated here rather than re-declared.
 */
const TranscriptViewSchema = Schema.Struct({
  /** The transcript rows (`transcriptUpdate.ts`) plus the compaction rows,
   *  in first-appearance order. */
  rows: Schema.Array(Schema.declare((_u): _u is TranscriptRow => true)),
  /** One entry per stage: a plugin's section, opened by `stage.start` and
   *  closed by `stage.end`, or a script's, projected from its `script` card
   *  and the cards under it. */
  stages: Schema.Array(StageSchema),
  /** The contiguous leading prefix of rows whose finalizing event has been
   *  applied: what an append-only scrollback may print. */
  settledRows: Count,
});
export type TranscriptView = typeof TranscriptViewSchema.Type;

/** One run as every renderer reads it; `SessionView.runs` holds them. */
export const RunViewSchema = Schema.Struct({
  /** The run id: the aggregate's logical id, minted once at launch. */
  id: RunIdSchema,
  /** From `run.start`; every run has one. */
  identity: RunIdentitySchema,
  /** The run identity's display name: agent, tool, or script name. */
  label: Schema.String,
  /** The run's title: the user's rename, else the AI one-liner. */
  description: Schema.NullOr(Schema.String),
  /** Who wrote `description`: a user title outlives later model ones. */
  descriptionBy: Schema.NullOr(Schema.Literals(['model', 'user'])),
  /** What every surface names the run by: `description`, else `label`. */
  title: Schema.String,
  model: Schema.NullOr(Schema.String),
  modelLabel: Schema.NullOr(Schema.String),
  /** Full, untruncated command that spawned a process run. */
  command: Schema.NullOr(Schema.String),
  /** The run's input files, from `run.config`. */
  inputFiles: Schema.Array(Schema.String),
  /** Its `delegationAgentScope` (a team's agents); null: any visible one. */
  agentScope: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  /** Each plugin row kind's latest value, by `plugin/kind` (`plugin.fact`):
   *  undecoded here, read through its plugin's reader. */
  facts: Schema.Record(FactNameSchema, JsonValueSchema),
  worktree: Schema.NullOr(WorktreeInfoSchema),
  /** Where its loop stands (`standingAfter`): `ready` before its first
   *  activation and after an end, `running` inside a turn, `waiting`
   *  between turns. */
  position: RunPositionSchema,
  /** The outcome `run.end` wrote; null until the run ends, and again once a
   *  follow-up's `run.activate` restarts it. */
  outcome: Schema.NullOr(RunOutcomeSchema),
  /** Whether a launch in this process drives it: `here` from its
   *  activation until its end. A run with no outcome that nobody here
   *  holds is interrupted (its process stopped before it finished). */
  holder: Schema.Literals(['here', 'none']),
  /** What `run.end` stored as the run's output; `run.activate` clears it. */
  output: Schema.NullOr(RunEndSchema.fields.output),
  /** What the run's banner says (`RunNoticeSchema`); null: nothing. */
  statusNotice: Schema.NullOr(RunNoticeSchema),
  /** The result its end lost (a `result-lost` error), whatever its outcome. */
  lost: Schema.NullOr(Schema.String),
  /** Immutable: the commit ordinal of this run's `run.start`; the
   *  ordering key. */
  createdAt: CommitOrdinalSchema,
  /** Wall-clock time of `run.start`, ms since the epoch: the launch time a
   *  host prints. `createdAt` orders; this never does. */
  launchedAt: Positive,
  /** The current turn's start as the rows record it: the fold's input to
   *  `runStartedAt`, kept while the run's holder is not yet known. */
  turnStartedAt: Schema.NullOr(Positive),
  /** The clock a host shows: the turn's start while the run is busy on it;
   *  null while it waits on a person, is interrupted, paused or between turns. */
  runStartedAt: Schema.NullOr(Positive),
  lastTimestamp: Schema.Number,
  /** The run's one-based turn, from its latest `run.position` (the loop
   *  commits `state.turn + 1`; the row's `round` counts model calls). Null
   *  before the first position, after every activation, and for a process
   *  run, which has no loop of its own. */
  turn: Schema.NullOr(Count),
  /** `run.start.takesFollowUps`. */
  takesFollowUps: Schema.Boolean,
  /** Latest `context.state`. */
  context: Schema.NullOr(ContextStateDataSchema),
  /** The run it is attached to now: its launcher until a detach. */
  parentId: Schema.NullOr(RunIdSchema),
  /** Its launch edge (`run.start.parent`), which a detach keeps: the run
   *  that launched it, and that run's tool card it was launched from
   *  (`parent.call.card`; null for a launch no call made). Null for a root. */
  launch: Schema.NullOr(
    Schema.Struct({ id: RunIdSchema, card: Schema.NullOr(Schema.String) }),
  ),
  /** The task this one was forked from and the settled point it was cut at
   *  (`run.start.provenance`); null for a run its own launch began. */
  forkedFrom: Schema.NullOr(Schema.Struct({ id: RunIdSchema, at: Positive })),
  /** The `seq` of the run's newest wait (a `run.position` at `waiting`):
   *  the point a whole-task fork cuts at; null before its first turn ends,
   *  when there is nothing to fork. */
  forkPoint: Schema.NullOr(Positive),
  /** Root first. */
  ancestors: Schema.Array(
    Schema.Struct({ id: RunIdSchema, label: Schema.String }),
  ),
  /** `runOrdering` rule. */
  childIds: Schema.Array(RunIdSchema),
  /** Descendants by status: `running` counts the held ones still inside a
   *  turn or not started, `finished` the ended ones and those waiting idle
   *  between turns. No separate waiting or interrupted count: both
   *  outrank a collapsed parent (`needsUser`), so it never hides a row that
   *  needs the user. */
  rollup: Schema.Struct({ total: Count, running: Count, finished: Count }),
  approval: Schema.Literals(['none', 'own', 'descendant']),
  /** What a host may offer on the run now (`runActions`). */
  actions: Schema.Array(RunActionSchema),
  /** The run's metered total. A `usage` row is one priced turn and the view
   *  sums them; a cold listing read delivers the store's per-run sum as one
   *  row instead, which the view takes as the total, so both reads leave the
   *  same figure here. */
  usage: TokenUsageStatsSchema,
  /** The spend of this run and every run under it, finished or not: its own
   *  `usage` plus each child's `treeUsage`, summed once per change on the
   *  walk to the root. The one task total every host shows (footer, script
   *  card, status line), so no host sums a tree. */
  treeUsage: TokenUsageStatsSchema,
  /** The newest thinking row is still streaming. */
  thinkingActive: Schema.Boolean,
  /** A context compaction is in progress. */
  compactingActive: Schema.Boolean,
  /** The run's latest line: a script run's newest operational summary,
   *  any other run's newest user instruction or settled model reply. */
  latestLine: Schema.NullOr(Schema.String),
  transcript: TranscriptViewSchema,
  /** A task's run: the key of the plugin block whose recipe it opened on
   *  (`script.block`); null otherwise. A task takes no messages. */
  recipe: Schema.NullOr(Schema.String),
});
export type RunView = typeof RunViewSchema.Type;

/**
 * What `children` and their descendants count toward a parent's `rollup`:
 * the view's count over the run tree (each child's own `rollup` below it),
 * and the dispatch card's over the tree it lists (`below` recurses through
 * the children it lists instead). A child waiting between turns (held) or
 * paused, nothing asked of the user, has delivered its turn: it counts as
 * finished, not running.
 */
export function rollupOf(
  children: readonly ReadRunView[],
  below = (child: ReadRunView) => child.rollup,
): ReadRunView['rollup'] {
  const rollup = { total: 0, running: 0, finished: 0 };
  for (const child of children) {
    const idle =
      child.holder === 'here' &&
      child.position === 'waiting' &&
      child.approval !== 'own';
    const under = below(child);
    rollup.total += 1 + under.total;
    rollup.running +=
      (child.holder === 'here' && !idle ? 1 : 0) + under.running;
    rollup.finished +=
      (child.outcome !== null || idle ? 1 : 0) + under.finished;
  }
  return rollup;
}

/** Whether nobody drives the run although it has not ended: its process
 *  stopped before it finished, and a resume continues it. */
export const isInterrupted = (
  run: Pick<ReadRunView, 'holder' | 'outcome'>,
): boolean => run.holder === 'none' && run.outcome === null;

/** Whether the run is working a turn in this process right now (a pending
 *  approval or question is still the turn's). */
export const isWorking = (
  run: Pick<ReadRunView, 'holder' | 'position'>,
): boolean => run.holder === 'here' && run.position === 'running';

/**
 * Whether the run or a run under it needs the user: a request of its own
 * waits here, it is interrupted, or a descendant needs the user. Outranks a
 * surface's collapsed choice.
 */
export function needsUser(
  run: ReadRunView,
  runs: ReadonlyMap<RunId, ReadRunView>,
): boolean {
  if (run.approval !== 'none' || isInterrupted(run)) return true;
  return run.childIds.some((id) => {
    const child = runs.get(id);
    return child !== undefined && needsUser(child, runs);
  });
}

/** Whether this build cannot read the run's rows (`RunNoticeSchema`). */
export const isUnreadable = (run: Pick<ReadRunView, 'statusNotice'>): boolean =>
  run.statusNotice?.kind === 'damaged' ||
  run.statusNotice?.kind === 'earlierBuild';

/**
 * Whether a run takes a follow-up at all, the one rule every host reads (it
 * decides whether the composer shows). A run launched taking none
 * (`takesFollowUps`) and a run whose rows this build cannot read take none;
 * a run still going or waiting takes one, as does a stopped root agent with
 * saved steps, which a resume continues from its history.
 */
export function acceptsFollowUp(run: ReadRunView): boolean {
  if (!run.takesFollowUps || isUnreadable(run)) return false;
  if (run.holder === 'here' && run.position !== 'ready') return true;
  return (
    run.identity.kind === 'agent' &&
    run.parentId === null &&
    !run.recipe &&
    (run.turn !== null || run.forkPoint !== null)
  );
}

/**
 * Whether this window can answer a pending request: the one rule the host's
 * attention badge and the request card both read, matching what
 * `SessionRequests.decide` accepts. A request that blocks its caller is
 * answered by the fiber waiting on it, so only while its run waits here; an
 * interrupted run has to be resumed first. One that does not, at any time.
 */
export type RequestAnswerability = 'answerable' | 'resume';
export function requestAnswerability(
  run: ReadRunView,
  payload: RequestPayload,
): RequestAnswerability {
  if (run.approval === 'own' || !blocksCaller(payload)) return 'answerable';
  return 'resume';
}

/** A pending request: which run asks, the payload the UI shows and who
 *  answers it. The list is a set keyed by `requestId`: opened without
 *  decided. */
const PendingRequestSchema = Schema.Struct({
  runId: RunIdSchema,
  requestId: Schema.String,
  payload: RequestPayloadSchema,
  answeredBy: AnsweredBySchema,
});

/** A run's queued follow-ups as a composer lists them (`followUpDisplay`):
 *  a set keyed by `followUpId`, queued, unconsumed, in order. */
const QueuedFollowUpsSchema = Schema.Array(
  Schema.Struct({ followUpId: Schema.String, text: Schema.String }),
);

/** One session's view at one moment: its runs, requests and grants. */
export const SessionViewSchema = Schema.Struct({
  key: SessionKeySchema,
  runs: Schema.ReadonlyMap(RunIdSchema, RunViewSchema),
  /** Top-level ids, `runOrdering` rule. */
  order: Schema.Array(RunIdSchema),
  /** The drained tail position, including rows no longer materialized.
   *  Listing and history rows never advance it. */
  cursor: CommitOrdinalSchema,
  /**
   * Transcript verbosity (`logger.debugMode`), sampled by the process
   * reader and carried with the replay — never stamped onto a row. The whole
   * view uses the replay's value, so a settings flip takes effect on the
   * next replay, not mid-batch.
   */
  debug: Schema.Boolean,
  /** One entry per subscribed aggregate: the highest seq its transcript has
   *  applied (the subscription's `fromSeq` until a row is applied). Created
   *  when the aggregate enters the subscription set, deleted with its
   *  transcript when it leaves; never a commit ordinal. */
  transcriptSeq: Schema.ReadonlyMap(AggregateIdSchema, Count),
  /** Project-level aggregate; a rail badge reads it and derives nothing. */
  rollup: Schema.Struct({ running: Count, waiting: Count, interrupted: Count }),
  requests: Schema.Array(PendingRequestSchema),
  /** Latest snapshot per run. */
  policy: Schema.ReadonlyMap(RunIdSchema, ApprovalPolicySnapshotSchema),
  pluginFacts: Schema.Array(PluginFactDraftSchema),
  queuedFollowUps: Schema.ReadonlyMap(RunIdSchema, QueuedFollowUpsSchema),
});
export type SessionView = typeof SessionViewSchema.Type;

/** The run under `id`, which the view holds: an id in `order` or a run's
 *  `childIds` names a run of `runs`, so a miss is a broken view and throws. */
export function requireRun(
  view: Pick<SessionView, 'runs'>,
  id: RunId,
): RunView {
  const run = view.runs.get(id);
  if (run === undefined) throw new Error(`The session view holds no run ${id}`);
  return run;
}

/** What wants this window: the requests it can answer (the badge), and since
 *  `previous` (none without it) the new ones and the runs that ended. */
export interface Attention<Request> {
  readonly requests: readonly Request[];
  readonly arrived: readonly Request[];
  readonly finished: readonly ReadRunView[];
}

function answerableRequests<View extends ReadSessionView>(
  view: View,
): View['requests'][number][] {
  return view.requests.filter((request) => {
    const run = view.runs.get(request.runId);
    return (
      run !== undefined &&
      requestAnswerability(run, request.payload) === 'answerable'
    );
  });
}

/**
 * The one attention rule every host reads (the extension's badge, reveal and
 * chime, the desktop's dock badge, notifications, and rail): a request wants
 * the user when this window can answer it (not one on a run another process
 * holds or waiting for its run's resume), and a run when its outcome lands.
 */
export function attentionOf<View extends ReadSessionView>(
  view: View,
  previous?: ReadSessionView,
): Attention<View['requests'][number]> {
  const requests = answerableRequests(view);
  if (previous === undefined) return { requests, arrived: [], finished: [] };
  const known = new Set(answerableRequests(previous).map((r) => r.requestId));
  return {
    requests,
    arrived: requests.filter((request) => !known.has(request.requestId)),
    finished: [...view.runs.values()].filter(
      ({ id, outcome }) =>
        outcome !== null && previous.runs.get(id)?.outcome === null,
    ),
  };
}

/** How busy a session reads in a title: idle, running, or awaiting approval. */
export type SessionTitleState = 'idle' | 'running' | 'approval';
/**
 * The project-level activity every title and status pill shows, read from the
 * view and nothing else: a request this window can answer outranks a run
 * working right now; a conversation waiting on its user is idle.
 */
export function sessionActivity(view: ReadSessionView): SessionTitleState {
  if (answerableRequests(view).length > 0) return 'approval';
  for (const run of view.runs.values()) if (isWorking(run)) return 'running';
  return 'idle';
}

/**
 * The empty view an updater starts from: keyed by its session, its cursor at
 * zero, and its verbosity flag. A replay's `debug` input replaces it when the
 * verbosity changes.
 */
export function emptySessionView(key: string, debug = false): SessionView {
  return {
    key,
    runs: new Map(),
    order: [],
    cursor: 0,
    debug,
    transcriptSeq: new Map(),
    rollup: { running: 0, waiting: 0, interrupted: 0 },
    requests: [],
    policy: new Map(),
    pluginFacts: [],
    queuedFollowUps: new Map(),
  };
}

/**
 * Every run under `rootRunId`, parents first: the topology `childIds`
 * (root to leaf) and `ancestors` (leaf to root) already state on every row,
 * so a host walks the view's own facts instead of re-deriving them.
 */
export function descendantRuns(
  view: Pick<ReadSessionView, 'runs'>,
  rootRunId: RunId | undefined,
  { includeRoot }: { includeRoot: boolean },
): readonly RunId[] {
  if (rootRunId === undefined) return [];
  const out: RunId[] = [];
  // An index cursor, not `Array.shift()`, keeps a large fan-out's walk linear.
  const pending = [rootRunId];
  const seen = new Set<RunId>();
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const id = pending[cursor];
    const run = view.runs.get(id);
    if (!run || seen.has(id)) continue;
    seen.add(id);
    if (includeRoot || id !== rootRunId) out.push(id);
    pending.push(...run.childIds);
  }
  return out;
}
