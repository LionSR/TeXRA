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

import {
  AgentCategory,
  AggregateIdSchema,
  ApprovalPolicySnapshotSchema,
  CommitOrdinalSchema,
  ContextStateDataSchema,
  ConversationProgressSchema,
  GoalStateSchema,
  InquiryThreadUpdatedEventSchema,
  OwnerIdSchema,
  PermissionPayloadSchema,
  PlanSchema,
  requestParksItsCaller,
  RoundKeyedOutputSidecarValueSchemas,
  RunIdentitySchema,
  RunFlowSchema,
  RunOutcomeSchema,
  RUN_LIFECYCLE_READY,
  RunPhaseSchema,
  RunSubstateSchema,
  RunIdSchema,
  TaskGroupSchema,
  TodoItemSchema,
  TokenUsageStatsSchema,
  UserFollowUpSupportSchema,
  WorktreeInfoSchema,
  type PermissionPayload,
  type RunId,
} from '@shared/schemas';
import { isTerminalOutcomePhase } from '@shared/runs/runStatus';
import { RUN_STATUS_TONE } from '@shared/runs/runStatusDisplay';
import type { WorkflowRunModel } from '@shared/runs/workflowRunModel';
import type { TranscriptRow } from '@ui/transcript';

/** Which session (paper) a view is of: the session's storage root. */
const SessionKeySchema = z.string().min(1);

/**
 * A run's transcript slice: what hosts paint, and nothing else. The fold
 * keeps its incremental indexes (row and group positions, the compaction
 * projection's working state, the measured live text per streaming row, the
 * newest plan marker) beside the value in a module-private map, so a host
 * can neither depend on nor mutate them. The slice value is replaced on every
 * change and `rows` and `taskGroups` are never written after the fold that
 * produced them returns (D5); hosts read, never write.
 *
 * The row, block, and run-model elements are the shared renderers' own
 * TypeScript shapes (`transcriptRow.ts`, `compactionActivityProjection.ts`,
 * `workflowRunModel.ts`); they have no schema of their own yet, so the
 * element types are stated rather than re-declared here.
 */
const TranscriptViewSchema = z.object({
  /** `projectTranscriptRow` over every entry plus the compaction rows, in
   *  wire append order. */
  rows: z.array(z.custom<TranscriptRow>()),
  /** `taskGroupOnStage` over the stage events. */
  taskGroups: z.array(TaskGroupSchema),
  /** The contiguous leading prefix of rows whose finalizing event has
   *  folded: what an append-only scrollback may print. */
  settledRows: z.int().nonnegative(),
  /** `workflowRunModel`, for a workflow-script run; null for every other. */
  run: z.custom<WorkflowRunModel>().nullable(),
});
export type TranscriptView = z.infer<typeof TranscriptViewSchema>;

const RunGroupSchema = z.enum(['running', 'waiting', 'interrupted', 'recent']);
/** The section a run sorts into. Its labels and section order are one
 *  table in `@shared/runs/runStatusDisplay`, not a per-host switch. */
export type RunGroup = z.infer<typeof RunGroupSchema>;

const RunViewCommonSchema = z.object({
  /** The run id: the aggregate's logical id, minted once at launch. */
  id: RunIdSchema,
  /** From `run.start`; every run has one. */
  identity: RunIdentitySchema,
  // Launch facts from the `run.start` payload, never derived (5.2).
  isRemote: z.boolean(),
  /** Current sequence-row owner; null when unclaimed. */
  ownerId: OwnerIdSchema.nullable(),
  /** The current claim belongs to this process, independently of parentage. */
  ownedHere: z.boolean(),
  /** The run identity's display name: agent, tool, or workflow name. */
  label: z.string(),
  /** The AI one-liner; title when present. */
  description: z.string().nullable(),
  model: z.string().nullable(),
  modelLabel: z.string().nullable(),
  /** Full, untruncated command that spawned a process run. */
  command: z.string().nullable(),
  /** The run's input files, from `run.config`. */
  inputFiles: z.array(z.string()),
  worktree: WorktreeInfoSchema.nullable(),
  /** The durable phase, folded from `run.activate` (running), `flow.step`
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
   * while the flow still writes its closing rows); for any other run, the
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
  /** The loop's latest `flow.step`: family, step, and coordinates. Null
   *  before the first step and after every activation, and null for the
   *  whole life of a run with no loop of its own — an agent-CLI child
   *  parks through `child.park`, which carries a phase and no position. */
  flow: RunFlowSchema.nullable(),
  followUpSupport: UserFollowUpSupportSchema,
  /** A native tool-use resume can target this run: a plain agent identity in
   *  the tool-use category. The rule lives here so no host restates it. */
  resumeEligible: z.boolean(),
  /** Latest `context.state`. */
  context: ContextStateDataSchema.nullable(),
  parentId: RunIdSchema.nullable(),
  /** Root first. */
  ancestors: z.array(z.object({ id: RunIdSchema, label: z.string() })),
  /** `runOrdering` rule. */
  childIds: z.array(RunIdSchema),
  /** Descendants by status; `running` counts the live ones (`isLiveRun`).
   *  No separate waiting or interrupted count: both force expansion, so a
   *  collapsed parent never hides a row that needs the user. */
  rollup: z.object({
    total: z.int().nonnegative(),
    running: z.int().nonnegative(),
    finished: z.int().nonnegative(),
  }),
  approval: z.enum(['none', 'own', 'descendant']),
  /** This process cannot act on it: another live owner, or unreadable (5.2). */
  readOnly: z.boolean(),
  /** This run or a descendant needs the user; outranks the surface's
   *  collapsed choice. */
  forceExpanded: z.boolean(),
  group: RunGroupSchema,
  /** The run's metered total: the newest `usage` row this run has folded.
   *  Each row carries the run's cumulative totals, not a round's delta, so a
   *  cold listing read — which delivers only the newest row per run — leaves
   *  the same total here as a full aggregate replay. */
  usage: TokenUsageStatsSchema,
  /** The newest thinking row is still streaming. */
  thinkingActive: z.boolean(),
  /** A context compaction is in progress. */
  compactingActive: z.boolean(),
  /** The run's latest line: a workflow run's newest operational summary,
   *  any other run's newest user instruction or settled model reply. */
  latestLine: z.string().nullable(),
  transcript: TranscriptViewSchema,
  // Shared by both categories: `output.produced` carries the complete round
  // collection for missing outputs and compile failures. A cold listing read
  // delivers its newest row per run, yielding the same maps as full replay.

  missingOutputs: RoundKeyedOutputSidecarValueSchemas.missingOutputs,
  compileFailures: RoundKeyedOutputSidecarValueSchemas.compileFailures,
});

const ToolUseRunViewSchema = RunViewCommonSchema.extend({
  category: z.literal(AgentCategory.ToolUse),
  todos: z.array(TodoItemSchema),
  plan: PlanSchema.nullable(),
  /** Per run: concurrent runs hold independent goals. */
  goal: GoalStateSchema,
  outputs: RoundKeyedOutputSidecarValueSchemas.outputFiles,
});

const WorkflowRunViewSchema = RunViewCommonSchema.extend({
  category: z.literal(AgentCategory.Workflow),
  files: RoundKeyedOutputSidecarValueSchemas.outputFiles,
});

const RunViewSchema = z.discriminatedUnion('category', [
  ToolUseRunViewSchema,
  WorkflowRunViewSchema,
]);
export type RunView = z.infer<typeof RunViewSchema>;

/**
 * The one reading of "live" every host shares: a run somebody holds that has
 * not ended. An interrupted run's durable phase may still say in flight, but
 * nothing is working on it, so no roster, rollup, or status bar counts it.
 * Not `group` alone: a spawned child that has not activated yet is `ready`
 * and sorts under `recent`, yet it is live.
 */
export function isLiveRun(run: Pick<RunView, 'group' | 'status'>): boolean {
  return run.group !== 'interrupted' && !isTerminalOutcomePhase(run.status);
}

/** What a host can do with a follow-up, the only input the host brings to
 *  `acceptsFollowUp`: whether it delivers one to a terminal-backed run (an
 *  external agent CLI such as codex). */
export interface FollowUpHost {
  readonly terminalBacked: boolean;
}

/**
 * Whether a run takes a follow-up at all, the one rule every host reads: what
 * decides the composer is shown for it, and therefore what a host action
 * aimed at it may assume. A run that declares no follow-up support, a
 * terminal-backed run on a host that cannot drive one, and a run this process
 * may not act on take none; otherwise a run still going or waiting takes one,
 * as does a conversation that has not started (`ready` with nothing written
 * yet).
 */
export function acceptsFollowUp(run: RunView, host: FollowUpHost): boolean {
  if (run.followUpSupport === 'unsupported' || run.readOnly) return false;
  if (run.followUpSupport === 'terminalBacked' && !host.terminalBacked) {
    return false;
  }
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
  if (run.approval === 'own' || !requestParksItsCaller(payload)) {
    return 'answerable';
  }
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
  inquiries: z.array(InquiryThreadUpdatedEventSchema),
  queuedFollowUps: z.map(RunIdSchema, z.array(QueuedFollowUpViewSchema)),
});
export type SessionView = z.infer<typeof SessionViewSchema>;

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
    inquiries: [],
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
