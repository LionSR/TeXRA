/**
 * The one session state every renderer reads (PRD one-fold-three-renderers,
 * section 5.1). Fold output, never persisted, never parsed: the schema is the
 * type's single source of truth, so a field lands here first and every host
 * reads the same name.
 *
 * `SessionView` holds `Map`s because it never crosses a bridge; only events,
 * chunks, and `local` do (8.1), and those are arrays and records.
 *
 * Interaction state (selection, drafts, recording, expansion, focus, scroll)
 * is never here (G3); `sessionPresentationBoundary.vitest.ts` pins the names.
 */
import { z } from 'zod';

import type { SessionTitleState } from '@shared/sessionTitle';

import {
  AggregateIdSchema,
  ApprovalPolicySnapshotSchema,
  BlockedAggregateSchema,
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
import { RUN_STATUS_TONE } from '@shared/runs/runStatusDisplay';
import type { TranscriptRow } from '@shared/transcript';

/** Which session (paper) a view is of: the session's storage root. */
const SessionKeySchema = z.string().min(1);

/**
 * A run's transcript slice: what hosts paint, and nothing else. The fold
 * keeps its incremental indexes (row and group positions, the compaction
 * projection's working state, the measured live text per streaming row)
 * beside the value in a module-private map, so a host
 * can neither depend on nor mutate them. The slice value is replaced on every
 * change and `rows` and `taskGroups` are never written after the fold that
 * produced them returns (D5); hosts read, never write.
 *
 * The row and block elements are the shared renderers' own TypeScript
 * shapes (`transcriptRow.ts`, `compactionActivityProjection.ts`); they have no schema of their own yet, so the
 * element types are stated rather than re-declared here.
 */
const TranscriptViewSchema = z.object({
  /** The transcript fold's rows (`transcriptFold.ts`) plus the compaction
   *  rows, in first-appearance order. */
  rows: z.array(z.custom<TranscriptRow>()),
  /** `taskGroupOnStage` over the stage events. */
  taskGroups: z.array(TaskGroupSchema),
  /** The contiguous leading prefix of rows whose finalizing event has
   *  folded: what an append-only scrollback may print. */
  settledRows: z.int().nonnegative(),
});
export type TranscriptView = z.infer<typeof TranscriptViewSchema>;

const RunGroupSchema = z.enum(['running', 'waiting', 'interrupted', 'recent']);
/** The section a run sorts into. Its labels and section order are one
 *  table in `@shared/runs/runStatusDisplay`, not a per-host switch. */
export type RunGroup = z.infer<typeof RunGroupSchema>;

const RunViewSchema = z.object({
  /** The run id: the aggregate's logical id, minted once at launch. */
  id: RunIdSchema,
  /** From `run.start`; every run has one. */
  identity: RunIdentitySchema,
  /** Current sequence-row owner; null when unclaimed. */
  ownerId: OwnerIdSchema.nullable(),
  /** The current claim belongs to this process, independently of parentage. */
  ownedHere: z.boolean(),
  /** The run identity's display name: agent, tool, or workflow name. */
  label: z.string(),
  /** The run's title: the user's rename, else the AI one-liner. */
  description: z.string().nullable(),
  /** Who wrote `description`: a user title outlives later model ones. */
  descriptionBy: z.enum(['model', 'user']).nullable(),
  /** What every surface names the run by: `description`, else `label`. */
  title: z.string(),
  model: z.string().nullable(),
  modelLabel: z.string().nullable(),
  /** Full, untruncated command that spawned a process run. */
  command: z.string().nullable(),
  /** The run's input files, from `run.config`. */
  inputFiles: z.array(z.string()),
  /** Each plugin row kind's latest value, by `plugin/kind` (`plugin.fact`):
   *  undecoded here, read through its plugin's reader. */
  facts: z.record(z.string(), JsonValueSchema),
  worktree: WorktreeInfoSchema.nullable(),
  /** The durable phase, folded from `run.activate` (running), `run.position`
   *  (`waiting` parks, any other step runs), `child.park` (an agent-CLI
   *  child's own park row, which has no loop to step), and `run.end` (the
   *  outcome); `ready` before the first activation folds (3.3). An
   *  interrupted run keeps it and reads as interrupted through the copy;
   *  unavailability is `readOnly`, never a status (5.2). */
  status: z.union([RunPhaseSchema, z.literal(RUN_LIFECYCLE_READY)]),
  /** Derived from the activation's position (ruling A9-1): a first
   *  activation is starting, a later one resuming, cleared by the first
   *  step. Only a run whose loop steps carries one. */
  substate: RunSubstateSchema.nullable(),
  /**
   * The terminal status once nothing can move it: for a run this process
   * owns, after its `run.end` has folded (a user stop publishes CANCELLED
   * while the loop still writes its closing rows); for any other run, the
   * terminal status itself. Null while anything can still move.
   * What licenses a host to paint an open group as interrupted and the
   * session to release the run's sidecar record.
   */
  durableOutcome: RunOutcomeSchema.nullable(),
  /** Banner copy beside the label: the local unreadable detail, else the
   *  interrupted or held notice; null otherwise. */
  statusDetail: z.string().nullable(),
  // G4: one table (`runStatusDisplay`) spells both, through the status
  // and substate or the interrupted reading.
  statusLabel: z.string(),
  tone: z.enum(RUN_STATUS_TONE),
  /** Immutable: the commit ordinal of this run's `run.start`; the
   *  ordering key. */
  createdAt: CommitOrdinalSchema,
  /** Wall-clock time of `run.start`, ms since the epoch: the launch time a
   *  host prints. `createdAt` orders; this never does. */
  launchedAt: z.int().positive(),
  runStartedAt: z.int().positive().nullable(),
  lastTimestamp: z.number().nullable(),
  conversationProgress: ConversationProgressSchema,
  /** The run's one-based turn, folded from its latest `run.position`
   *  (the loop commits `state.turn + 1`; the row's `round` counts model
   *  calls, so no surface reads it). Null before the first position and
   *  after every activation, and null for the whole life of a run with no
   *  loop of its own — an agent-CLI child parks through `child.park`, which
   *  carries a phase and no position. */
  turn: z.int().nonnegative().nullable(),
  followUpSupport: UserFollowUpSupportSchema,
  /** Latest `context.state`. */
  context: ContextStateDataSchema.nullable(),
  parentId: RunIdSchema.nullable(),
  /** The task this one was forked from and the settled point it was cut at
   *  (`run.start.provenance`); null for a run its own launch began. */
  forkedFrom: z.object({ id: RunIdSchema, at: z.int().positive() }).nullable(),
  /** The `seq` of the run's newest park (a `run.position` at `waiting` or
   *  `halted`): the settled point a whole-task fork cuts at; null before
   *  its first turn ends, when there is nothing to fork. */
  forkPoint: z.int().positive().nullable(),
  /** The parent's tool card that launched this run (`run.start.parentCard`). */
  parentCard: z.string().nullable(),
  /** Root first. */
  ancestors: z.array(z.object({ id: RunIdSchema, label: z.string() })),
  /** `runOrdering` rule. */
  childIds: z.array(RunIdSchema),
  /** Descendants by status: `running` counts the live ones (`isLiveRun`)
   *  still working a turn, `finished` the ended ones and those parked idle
   *  between turns. No separate waiting or interrupted count: both force
   *  expansion, so a collapsed parent never hides a row that needs the user. */
  rollup: z.object({
    total: z.int().nonnegative(),
    running: z.int().nonnegative(),
    finished: z.int().nonnegative(),
  }),
  approval: z.enum(['none', 'own', 'descendant']),
  /** This process cannot act on it: another live owner, unreadable (5.2), or
   *  `blocked`, a row this build cannot read (a newer or older TeXRA's, or corrupt). */
  readOnly: z.boolean(),
  blocked: BlockedAggregateSchema.shape.reason.nullable(),
  /** What a resume of this run waits for in this process (`statusDetail`
   *  words it); null when nothing blocks it. */
  resumeBlocked: ResumeBlockerSchema.nullable(),
  /** What a host may offer on the run now (`runActions`). */
  actions: z.array(RunActionSchema).readonly(),
  /** This run or a descendant needs the user; outranks the surface's
   *  collapsed choice. */
  forceExpanded: z.boolean(),
  group: RunGroupSchema,
  /** The run's metered total: the newest `usage` row this run has folded.
   *  Each row carries the run's cumulative totals, not a round's delta, so a
   *  cold listing read — which delivers only the newest row per run — leaves
   *  the same total here as a full aggregate replay. */
  usage: TokenUsageStatsSchema,
  /** The spend of this run and every run under it, finished or not: its own
   *  `usage` plus each child's `treeUsage`, folded once per change on the
   *  walk to the root. The one task total every host shows (footer, script
   *  card, status line), so no host sums a tree. */
  treeUsage: TokenUsageStatsSchema,
  /** The newest thinking row is still streaming. */
  thinkingActive: z.boolean(),
  /** A context compaction is in progress. */
  compactingActive: z.boolean(),
  /** The run's latest line: a workflow run's newest operational summary,
   *  any other run's newest user instruction or settled model reply. */
  latestLine: z.string().nullable(),
  transcript: TranscriptViewSchema,
  /** A document task's run: opened on its recipe (`run.config`), it
   *  revises files and takes no messages. */
  documentTask: z.boolean(),
  plan: PlanSchema.nullable(),
});
export type RunView = z.infer<typeof RunViewSchema>;

/**
 * The one reading of "live" every host shares: a run somebody holds that has
 * not ended. An interrupted run's durable phase may still say in flight, but
 * nothing is working on it, so no run list, rollup, or status bar counts it.
 * Not `group` alone: a spawned child that has not activated yet is `ready`
 * and sorts under `recent`, yet it is live.
 */
export function isLiveRun(
  run: Pick<RunView, 'group' | 'status' | 'substate'>,
): boolean {
  if (run.substate === RUN_SUBSTATE.PAUSED) return false;
  return run.group !== 'interrupted' && !isTerminalOutcomePhase(run.status);
}

/**
 * What `children` and their descendants count toward a parent's `rollup`:
 * the fold's count over the run tree (each child's own `rollup` below it),
 * and the dispatch card's over the tree it lists (`below` recurses through
 * the children it lists instead). A child parked between turns (held) or
 * paused, nothing asked of the user, has delivered its turn: it counts as
 * finished, not running.
 */
export function rollupOf(
  children: readonly RunView[],
  below: (child: RunView) => RunView['rollup'] = (child) => child.rollup,
): RunView['rollup'] {
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

/** What a host can do with a follow-up, the only input the host brings to
 *  `acceptsFollowUp`: whether it delivers one to a terminal-backed run (an
 *  external agent CLI such as codex). */
export interface FollowUpHost {
  readonly terminalBacked: boolean;
}

/**
 * Whether a run takes a follow-up at all, the one rule every host reads (it
 * decides whether the composer shows). A run with no follow-up support, a
 * terminal-backed run on a host that cannot drive one, and a run this process
 * may not act on take none; a run still going or waiting takes one, as does a
 * conversation not yet started (`ready`, nothing written).
 */
export function acceptsFollowUp(run: RunView, host: FollowUpHost): boolean {
  if (run.followUpSupport === 'unsupported' || run.readOnly) return false;
  if (run.followUpSupport === 'terminalBacked' && !host.terminalBacked)
    return false;
  if (run.group === 'running' || run.group === 'waiting') return true;
  return run.status === 'ready' && run.lastTimestamp === null;
}

/**
 * Whether this window can answer a pending request: the one rule the host's
 * attention badge and the request card both read, matching what
 * `SessionRequests.decide` accepts. A run this process may not act on
 * (`readOnly`) takes no answer here. A request that parks its caller is
 * answered by the fiber waiting on it, so only while its run waits here; an
 * interrupted run has to be resumed first. An inquiry, at any other time.
 */
export type RequestAnswerability = 'answerable' | 'readOnly' | 'resume';
export function requestAnswerability(
  run: RunView,
  payload: Pick<PermissionPayload, 'kind'>,
): RequestAnswerability {
  if (run.readOnly) return 'readOnly';
  if (run.approval === 'own' || !requestParksItsCaller(payload))
    return 'answerable';
  return 'resume';
}

/** A pending request: which run is asking, the payload the UI shows (its
 *  `kind` is the request's kind), and the earlier request it continues (an
 *  inquiry's thread). The list is a set keyed by `requestId` (5.2): opened
 *  without decided. */
const PendingRequestSchema = z.object({
  runId: RunIdSchema,
  requestId: z.string(),
  payload: PermissionPayloadSchema,
  thread: z.string().nullable(),
});

/** A queued follow-up as a composer lists it: the row's key and the text it
 *  shows (`displayText`, else `text`). Per run a set keyed by `followUpId`
 *  (5.2): queued without consumed, in queue order. */
const QueuedFollowUpViewSchema = z.object({
  followUpId: z.string(),
  text: z.string(),
});

const SessionViewSchema = z.object({
  key: SessionKeySchema,
  runs: z.map(RunIdSchema, RunViewSchema),
  /** Top-level ids, `runOrdering` rule. */
  order: z.array(RunIdSchema),
  /** The drained tail position, including rows no longer materialized.
   *  Listing and history rows never advance it. */
  cursor: CommitOrdinalSchema,
  /**
   * Transcript verbosity (`texra.logger.debugMode`), sampled by the process
   * reader and carried with the replay — never stamped onto a row. The whole
   * fold answers with the replay's value, so a settings flip takes effect on
   * the next replay, not mid-fold.
   */
  debug: z.boolean(),
  /** One entry per subscribed aggregate: the highest seq the fold has
   *  retained for it (the subscription's `fromSeq` until a row folds).
   *  Created when the aggregate enters the subscription set, deleted with
   *  its transcript tier on eviction; never a commit ordinal. */
  folded: z.map(AggregateIdSchema, z.int().nonnegative()),
  /** Paper-level aggregate; a rail badge reads it and derives nothing. */
  rollup: z.object({
    running: z.int().nonnegative(),
    waiting: z.int().nonnegative(),
    interrupted: z.int().nonnegative(),
  }),
  requests: z.array(PendingRequestSchema),
  /** Latest snapshot per run. */
  policy: z.map(RunIdSchema, ApprovalPolicySnapshotSchema),
  pluginFacts: z.array(PluginFactDraftSchema),
  queuedFollowUps: z.map(RunIdSchema, z.array(QueuedFollowUpViewSchema)),
});
export type SessionView = z.infer<typeof SessionViewSchema>;

type PendingRequest = SessionView['requests'][number];

/** What in one session wants the user of this window. */
export interface Attention {
  /** The requests this window can answer (`requestAnswerability`), in fold
   *  order: what every badge counts. */
  readonly requests: readonly PendingRequest[];
  /** Those `previous` could not answer: what brings a run forward or raises
   *  a notification. Empty without a `previous`, since the first view a
   *  host reads is history, not news. */
  readonly arrived: readonly PendingRequest[];
}

function answerableRequests(view: SessionView): PendingRequest[] {
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
export function attentionOf(
  view: SessionView,
  previous?: SessionView,
): Attention {
  const requests = answerableRequests(view);
  if (previous === undefined) return { requests, arrived: [] };
  const known = new Set(
    answerableRequests(previous).map((request) => request.requestId),
  );
  return {
    requests,
    arrived: requests.filter((request) => !known.has(request.requestId)),
  };
}

/** A live run working right now: not a conversation parked on its user. */
export function isWorkingRun(run: RunView): boolean {
  return isLiveRun(run) && isActivePhase(run.status);
}

/**
 * The paper-level activity every title and status pill shows, read from the
 * fold and nothing else: a request this window can answer outranks a run
 * working right now; a conversation parked on its user is idle.
 */
export function sessionActivity(view: SessionView): SessionTitleState {
  if (answerableRequests(view).length > 0) return 'approval';
  for (const run of view.runs.values()) if (isWorkingRun(run)) return 'running';
  return 'idle';
}

/**
 * The empty view a fold starts from: keyed by its session, its cursor at the
 * layer's tail anchor (PRD 7.2), and its initial verbosity flag. Built once
 * per fold fiber; a replay's first input can replace it when policy changes.
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
    folded: new Map(),
    rollup: { running: 0, waiting: 0, interrupted: 0 },
    requests: [],
    policy: new Map(),
    pluginFacts: [],
    queuedFollowUps: new Map(),
  };
}

/** The read shape `descendantRuns` needs: satisfied by `SessionView`
 *  itself and by any deep-readonly projection of it (a `Map` structurally
 *  satisfies `ReadonlyMap`), so a consumer holding a readonly view never
 *  needs to re-derive the walk to keep its own copy. */
type RunTopology = {
  readonly runs: ReadonlyMap<RunId, { readonly childIds: readonly RunId[] }>;
};

/**
 * Every run under `rootRunId`, parents first: the topology `childIds`
 * (root to leaf) and `ancestors` (leaf to root) already state on every row,
 * so a host walks the fold's own facts instead of re-deriving them.
 */
export function descendantRuns(
  view: RunTopology,
  rootRunId: RunId | undefined,
  { includeRoot }: { includeRoot: boolean },
): readonly RunId[] {
  if (rootRunId === undefined) return [];
  const out: RunId[] = [];
  // An index cursor over an append-only queue keeps this linear in the
  // topology's size; `Array.shift()` would re-index the remainder on every
  // pop and make a large fan-out's walk quadratic.
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
