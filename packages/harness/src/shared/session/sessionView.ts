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
// `sessionPresentationBoundary.vitest.ts` pins the interaction-state names.
import { Schema } from 'effect';

import { ApprovalPolicySnapshotSchema } from '@shared/approvalBypassKind';
import {
  AggregateIdSchema,
  ResumeBlockerSchema,
  CommitOrdinalSchema,
  ContextStateDataSchema,
  ConversationProgressSchema,
  JsonValueSchema,
  OwnerIdSchema,
  PermissionPayloadSchema,
  PlanSchema,
  PluginFactDraftSchema,
  requestParksItsCaller,
  RunActionSchema,
  RunIdentitySchema,
  RunNoticeSchema,
  RunOutcomeSchema,
  RUN_LIFECYCLE_READY,
  RUN_PHASE,
  RUN_SUBSTATE,
  RunPhaseSchema,
  RunSubstateSchema,
  RunIdSchema,
  TaskGroupSchema,
  TokenUsageStatsSchema,
  UserFollowUpSupportSchema,
  WorktreeInfoSchema,
  type PermissionPayload,
  type RunId,
} from '@shared/schemas';
import { isActivePhase, isTerminalOutcomePhase } from '@shared/runs/runStatus';
import {
  RUN_STATUS_KEYS,
  RUN_STATUS_TONE,
} from '@shared/runs/runStatusDisplay';
import type { TranscriptRow } from '@shared/transcript/transcriptRow';
import type {
  RunView as ReadRunView,
  SessionView as ReadSessionView,
} from './readonlyViews';

/** Which session (paper) a view is of: the session's storage root. */
const SessionKeySchema = Schema.NonEmptyString;

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
  /** One group per stage: opened by `stage.start`, closed by `stage.end`. */
  taskGroups: Schema.Array(TaskGroupSchema),
  /** The contiguous leading prefix of rows whose finalizing event has been
   *  applied: what an append-only scrollback may print. */
  settledRows: Count,
});
export type TranscriptView = typeof TranscriptViewSchema.Type;

/** The section a run sorts into. Its labels and section order are one
 *  table in the app's `@ui/copy/runStatus`, not a per-host switch. */
const RunGroupSchema = Schema.Literals([
  'running',
  'waiting',
  'interrupted',
  'recent',
]);

const RunViewSchema = Schema.Struct({
  /** The run id: the aggregate's logical id, minted once at launch. */
  id: RunIdSchema,
  /** From `run.start`; every run has one. */
  identity: RunIdentitySchema,
  /** Current sequence-row owner; null when unclaimed. */
  ownerId: Schema.NullOr(OwnerIdSchema),
  /** The current claim belongs to this process, independently of parentage. */
  ownedHere: Schema.Boolean,
  /** The run identity's display name: agent, tool, or workflow name. */
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
  facts: Schema.Record(Schema.String, JsonValueSchema),
  worktree: Schema.NullOr(WorktreeInfoSchema),
  /** The durable phase, from `run.activate` (running), `run.position`
   *  (`waiting` waits, any other step runs), `child.park` (an agent-CLI
   *  child's own wait row, which has no loop to step), and `run.end` (the
   *  outcome); `ready` before the first activation. An interrupted run
   *  keeps it and reads as interrupted through the copy; unavailability is
   *  `readOnly`, never a status. */
  status: Schema.Union([RunPhaseSchema, Schema.Literal(RUN_LIFECYCLE_READY)]),
  /** Derived from the activation's position: a first activation is
   *  starting, a later one resuming, cleared by the first step. Only a run
   *  whose loop steps carries one. */
  substate: Schema.NullOr(RunSubstateSchema),
  /** The outcome `run.end` wrote; null until the run ends, and again once a
   *  follow-up's `run.activate` restarts it. Lets a host paint an open group
   *  as interrupted and the session release the run's sidecar record. */
  durableOutcome: Schema.NullOr(RunOutcomeSchema),
  /** What the run's banner says (`RunNoticeSchema`); null: nothing. */
  statusNotice: Schema.NullOr(RunNoticeSchema),
  /** The result its end lost (a `result-lost` error), whatever its outcome. */
  lost: Schema.NullOr(Schema.String),
  // One table (`runStatusDisplay`) keys both, through the status and
  // substate or the interrupted reading; `@ui/copy/runStatus` words the key.
  statusKey: Schema.Literals(RUN_STATUS_KEYS),
  tone: Schema.Enum(RUN_STATUS_TONE),
  /** Immutable: the commit ordinal of this run's `run.start`; the
   *  ordering key. */
  createdAt: CommitOrdinalSchema,
  /** Wall-clock time of `run.start`, ms since the epoch: the launch time a
   *  host prints. `createdAt` orders; this never does. */
  launchedAt: Positive,
  runStartedAt: Schema.NullOr(Positive),
  lastTimestamp: Schema.Number,
  conversationProgress: ConversationProgressSchema,
  /** The run's one-based turn, from its latest `run.position` (the loop
   *  commits `state.turn + 1`; the row's `round` counts model calls, so no
   *  surface reads it). Null before the first position and after every
   *  activation, and null for the whole life of a run with no loop of its
   *  own — an agent-CLI child waits through `child.park`, which carries a
   *  phase and no position. */
  turn: Schema.NullOr(Count),
  followUpSupport: UserFollowUpSupportSchema,
  /** Latest `context.state`. */
  context: Schema.NullOr(ContextStateDataSchema),
  parentId: Schema.NullOr(RunIdSchema),
  /** The task this one was forked from and the settled point it was cut at
   *  (`run.start.provenance`); null for a run its own launch began. */
  forkedFrom: Schema.NullOr(Schema.Struct({ id: RunIdSchema, at: Positive })),
  /** The `seq` of the run's newest wait (a `run.position` at `waiting` or
   *  `halted`): the settled point a whole-task fork cuts at; null before
   *  its first turn ends, when there is nothing to fork. */
  forkPoint: Schema.NullOr(Positive),
  /** The parent's tool card that launched this run (`run.start.parentCard`). */
  parentCard: Schema.NullOr(Schema.String),
  /** Root first. */
  ancestors: Schema.Array(
    Schema.Struct({ id: RunIdSchema, label: Schema.String }),
  ),
  /** `runOrdering` rule. */
  childIds: Schema.Array(RunIdSchema),
  /** Descendants by status: `running` counts the live ones (`isLiveRun`)
   *  still working a turn, `finished` the ended ones and those waiting idle
   *  between turns. No separate waiting or interrupted count: both force
   *  expansion, so a collapsed parent never hides a row that needs the user. */
  rollup: Schema.Struct({ total: Count, running: Count, finished: Count }),
  approval: Schema.Literals(['none', 'own', 'descendant']),
  /** This process cannot act on it: another live owner, or unreadable. */
  readOnly: Schema.Boolean,
  /** What a resume of this run waits for here; null: nothing blocks it. */
  resumeBlocked: Schema.NullOr(ResumeBlockerSchema),
  /** What a host may offer on the run now (`runActions`). */
  actions: Schema.Array(RunActionSchema),
  /** This run or a descendant needs the user; outranks the surface's
   *  collapsed choice. */
  forceExpanded: Schema.Boolean,
  group: RunGroupSchema,
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
  /** The run's latest line: a workflow run's newest operational summary,
   *  any other run's newest user instruction or settled model reply. */
  latestLine: Schema.NullOr(Schema.String),
  transcript: TranscriptViewSchema,
  /** A task's run: the key of the plugin block whose recipe it opened on
   *  (`script.block`); null otherwise. A task takes no messages. */
  recipe: Schema.NullOr(Schema.String),
  plan: Schema.NullOr(PlanSchema),
});
export type RunView = typeof RunViewSchema.Type;

/**
 * The one reading of "live" every host shares: a run somebody holds that has
 * not ended. An interrupted run's durable phase may still say in flight, but
 * nothing is working on it, so no run list, rollup, or status bar counts it.
 * Not `group` alone: a spawned child that has not activated yet is `ready`
 * and sorts under `recent`, yet it is live.
 */
export function isLiveRun(
  run: Pick<ReadRunView, 'group' | 'status' | 'substate'>,
): boolean {
  if (run.substate === RUN_SUBSTATE.PAUSED) return false;
  return run.group !== 'interrupted' && !isTerminalOutcomePhase(run.status);
}

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
      child.status === RUN_PHASE.WAITING &&
      (child.group === 'running' || child.substate === RUN_SUBSTATE.PAUSED);
    const under = below(child);
    rollup.total += 1 + under.total;
    rollup.running += (isLiveRun(child) && !idle ? 1 : 0) + under.running;
    rollup.finished +=
      (isTerminalOutcomePhase(child.status) || idle ? 1 : 0) + under.finished;
  }
  return rollup;
}

/**
 * Whether a run takes a follow-up at all, the one rule every host reads (it
 * decides whether the composer shows). A run with no follow-up support and a
 * run this process may not act on take none; a run still going or waiting
 * takes one, as does a stopped native one with saved steps, which admission
 * resumes from its history. A terminal-backed run (an agent CLI such as
 * codex) reads its messages from the same inbox as any other run, so every
 * host delivers to it alike.
 */
export function acceptsFollowUp(run: ReadRunView): boolean {
  if (run.followUpSupport === 'unsupported' || run.readOnly) return false;
  if (run.group === 'running' || run.group === 'waiting') return true;
  return (
    run.followUpSupport === 'nativeInteractive' &&
    run.identity.kind === 'agent' &&
    run.parentId === null &&
    !run.recipe &&
    run.resumeBlocked === null &&
    (run.turn !== null || run.forkPoint !== null)
  );
}

/**
 * Whether this window can answer a pending request: the one rule the host's
 * attention badge and the request card both read, matching what
 * `SessionRequests.decide` accepts. A run this process may not act on
 * (`readOnly`) takes no answer here. A request that blocks its caller is
 * answered by the fiber waiting on it, so only while its run waits here; an
 * interrupted run has to be resumed first. An inquiry, at any other time.
 */
export type RequestAnswerability = 'answerable' | 'readOnly' | 'resume';
export function requestAnswerability(
  run: ReadRunView,
  payload: Pick<PermissionPayload, 'kind'>,
): RequestAnswerability {
  if (run.readOnly) return 'readOnly';
  if (run.approval === 'own' || !requestParksItsCaller(payload))
    return 'answerable';
  return 'resume';
}

/** A pending request: which run asks and the payload the UI shows. The list
 *  is a set keyed by `requestId`: opened without decided. */
const PendingRequestSchema = Schema.Struct({
  runId: RunIdSchema,
  requestId: Schema.String,
  payload: PermissionPayloadSchema,
});

/** A run's queued follow-ups as a composer lists them (`displayText`, else
 *  `text`): a set keyed by `followUpId`, queued, unconsumed, in order. */
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
   * Transcript verbosity (`texra.logger.debugMode`), sampled by the process
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
  /** Paper-level aggregate; a rail badge reads it and derives nothing. */
  rollup: Schema.Struct({ running: Count, waiting: Count, interrupted: Count }),
  requests: Schema.Array(PendingRequestSchema),
  /** Latest snapshot per run. */
  policy: Schema.ReadonlyMap(RunIdSchema, ApprovalPolicySnapshotSchema),
  pluginFacts: Schema.Array(PluginFactDraftSchema),
  queuedFollowUps: Schema.ReadonlyMap(RunIdSchema, QueuedFollowUpsSchema),
});
export type SessionView = typeof SessionViewSchema.Type;

/** What wants this window: the requests it can answer, in view order (the
 *  badge), and those `previous` could not (none without it: history). */
export interface Attention<Request> {
  readonly requests: readonly Request[];
  readonly arrived: readonly Request[];
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
 * The one attention rule every host reads (the extension's sidebar badge and
 * reveal, the desktop's dock badge, notifications, and rail): a request
 * wants the user exactly when this window can answer it, whatever its kind.
 * A request on a run another process holds, or one waiting for its run's
 * resume, is shown on its card but asks nothing of this window.
 */
export function attentionOf<View extends ReadSessionView>(
  view: View,
  previous?: ReadSessionView,
): Attention<View['requests'][number]> {
  const requests = answerableRequests(view);
  if (previous === undefined) return { requests, arrived: [] };
  const known = new Set(answerableRequests(previous).map((r) => r.requestId));
  return {
    requests,
    arrived: requests.filter((request) => !known.has(request.requestId)),
  };
}

/** A live run working right now: not a conversation waiting on its user. */
export function isWorkingRun(run: ReadRunView): boolean {
  return isLiveRun(run) && isActivePhase(run.status);
}

/** How busy a session reads in a title: idle, running, or awaiting approval. */
export type SessionTitleState = 'idle' | 'running' | 'approval';
/**
 * The paper-level activity every title and status pill shows, read from the
 * view and nothing else: a request this window can answer outranks a run
 * working right now; a conversation waiting on its user is idle.
 */
export function sessionActivity(view: ReadSessionView): SessionTitleState {
  if (answerableRequests(view).length > 0) return 'approval';
  for (const run of view.runs.values()) if (isWorkingRun(run)) return 'running';
  return 'idle';
}

/**
 * The empty view an updater starts from: keyed by its session, its cursor at
 * the layer's tail anchor, and its initial verbosity flag. A replay's
 * `debug` input replaces it when the verbosity changes.
 */
export function emptySessionView(
  key: string,
  cursor = 0,
  debug = false,
): SessionView {
  return {
    key,
    runs: new Map(),
    order: [],
    cursor,
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
    const id = pending[cursor]!;
    const run = view.runs.get(id);
    if (!run || seen.has(id)) continue;
    seen.add(id);
    if (includeRoot || id !== rootRunId) out.push(id);
    pending.push(...run.childIds);
  }
  return out;
}
