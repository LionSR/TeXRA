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
  ExecutionIdSchema,
  GoalStateSchema,
  InquiryThreadUpdatedEventSchema,
  OwnerIdSchema,
  PermissionPayloadSchema,
  PlanSchema,
  RoundKeyedOutputSidecarValueSchemas,
  RunIdentitySchema,
  RunOutcomeSchema,
  RunUsageMapSchema,
  STREAM_STATUS,
  StreamPhaseSchema,
  StreamStageSchema,
  StreamSubstateSchema,
  StreamTabIdSchema,
  TaskGroupSchema,
  TodoItemSchema,
  UserFollowUpSupportSchema,
  WorktreeInfoSchema,
} from '@shared/schemas';
import type { TranscriptRow } from '@shared/transcript';
import type { CompactionActivityBlock } from '@shared/streams/compactionActivityProjection';
import { STREAM_STATUS_TONE } from '@shared/streams/streamStatusDisplay';
import type { WorkflowRunModel } from '@shared/streams/workflowRunModel';

/** Which session (paper) a view is of: the session's storage root. */
const SessionKeySchema = z.string().min(1);

/**
 * A stream's transcript slice: what hosts paint, and nothing else. The fold
 * keeps its incremental indexes (row and group positions, the compaction
 * projection's working state, the measured live text per streaming row, the
 * newest plan marker) beside the value in a module-private map, so a host
 * can neither depend on nor mutate them. `rows`, `taskGroups`, and `compaction` are appended in
 * place by the fold (a copy per entry would make a replay quadratic) and the
 * slice value is replaced on every change; hosts read, never write.
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
  /** `upsertTaskGroupFromStreamLog` over the group entries. */
  taskGroups: z.array(TaskGroupSchema),
  /** `applyCompactionActivityEntries` blocks, in projection order. */
  compaction: z.array(z.custom<CompactionActivityBlock>()),
  /** The last session commit ordinal folded for this stream, over both of
   *  its aggregates; text chunks never move it. A memoization key, never a
   *  print boundary. */
  settledSeq: CommitOrdinalSchema,
  /** The contiguous leading prefix of rows whose finalizing event has
   *  folded: what an append-only scrollback may print. */
  settledRows: z.int().nonnegative(),
  /** `workflowRunModel`, for a workflow-script run; null for every other. */
  run: z.custom<WorkflowRunModel>().nullable(),
});
export type TranscriptView = z.infer<typeof TranscriptViewSchema>;

const StreamGroupSchema = z.enum([
  'running',
  'waiting',
  'interrupted',
  'recent',
]);

const StreamViewCommonSchema = z.object({
  id: StreamTabIdSchema,
  /** From `run.start`; 1:1 with `id`, never changes. */
  executionId: ExecutionIdSchema,
  /** Null only for legacy imports. */
  identity: RunIdentitySchema.nullable(),
  // Launch facts from the `run.start` payload, never derived (5.2).
  isRemote: z.boolean(),
  /** Owner of the latest durable event. */
  ownerId: OwnerIdSchema.nullable(),
  /** Agent name, or the id-prefix fallback for an identity-less stream. */
  label: z.string(),
  /** The AI one-liner; title when present. */
  description: z.string().nullable(),
  model: z.string().nullable(),
  modelLabel: z.string().nullable(),
  /** Full, untruncated command that spawned a process stream. */
  command: z.string().nullable(),
  /** The run's input files, from `run.config`. */
  inputFiles: z.array(z.string()),
  worktree: WorktreeInfoSchema.nullable(),
  /** The durable phase, or `ready` before the first `status` folds. An
   *  interrupted stream keeps it and reads as interrupted through the copy;
   *  unavailability is `readOnly`, never a status (5.2). */
  status: z.union([StreamPhaseSchema, z.literal(STREAM_STATUS.READY)]),
  substate: StreamSubstateSchema.nullable(),
  /**
   * The terminal status once nothing can move it: for a run this process
   * owns, after its lifecycle's `result` has folded (a user stop publishes
   * CANCELLED while the flow still writes its closing rows); for any other
   * run, the terminal status itself. Null while anything can still move.
   * What licenses a host to paint an open group as interrupted and the
   * session to release the stream's sidecar record.
   */
  durableOutcome: RunOutcomeSchema.nullable(),
  /** Banner copy beside the label: the local unreadable detail, else the
   *  interrupted or held notice; null otherwise. */
  statusDetail: z.string().nullable(),
  // G4: one table (`streamStatusDisplay`) spells both, through the status
  // and substate or the interrupted reading.
  statusLabel: z.string(),
  tone: z.enum(STREAM_STATUS_TONE),
  /** Immutable: the commit ordinal of this stream's `run.start`; the
   *  ordering key. */
  createdAt: CommitOrdinalSchema,
  runStartedAt: z.int().positive().nullable(),
  lastTimestamp: z.number().nullable(),
  conversationProgress: ConversationProgressSchema,
  stage: StreamStageSchema.nullable(),
  followUpSupport: UserFollowUpSupportSchema,
  /** Latest `context.state`. */
  context: ContextStateDataSchema.nullable(),
  parentId: StreamTabIdSchema.nullable(),
  /** Root first. */
  ancestors: z.array(z.object({ id: StreamTabIdSchema, label: z.string() })),
  /** `streamOrdering` rule. */
  childIds: z.array(StreamTabIdSchema),
  /** Descendants by status. No waiting or interrupted count: both force
   *  expansion, so a collapsed parent never hides a row that needs the user. */
  rollup: z.object({
    total: z.int().nonnegative(),
    running: z.int().nonnegative(),
    finished: z.int().nonnegative(),
  }),
  approval: z.enum(['none', 'own', 'descendant']),
  /** This process cannot act on it: another live owner, or unreadable (5.2). */
  readOnly: z.boolean(),
  /** This stream or a descendant needs the user; outranks a collapsed
   *  override. */
  forceExpanded: z.boolean(),
  group: StreamGroupSchema,
  usage: RunUsageMapSchema,
  /** The newest thinking row is still streaming. */
  thinkingActive: z.boolean(),
  /** A context compaction is in progress. */
  compactingActive: z.boolean(),
  /** The stream's latest line: a workflow run's newest operational summary,
   *  any other run's newest user instruction or settled model reply. */
  latestLine: z.string().nullable(),
  transcript: TranscriptViewSchema,
});

const ToolUseStreamViewSchema = StreamViewCommonSchema.extend({
  category: z.literal(AgentCategory.ToolUse),
  todos: z.array(TodoItemSchema),
  plan: PlanSchema.nullable(),
  /** Per stream: concurrent streams hold independent goals. */
  goal: GoalStateSchema,
  outputs: RoundKeyedOutputSidecarValueSchemas.outputFiles,
  missingOutputs: RoundKeyedOutputSidecarValueSchemas.missingOutputs,
  compileFailures: RoundKeyedOutputSidecarValueSchemas.compileFailures,
});

const WorkflowStreamViewSchema = StreamViewCommonSchema.extend({
  category: z.literal(AgentCategory.Workflow),
  files: RoundKeyedOutputSidecarValueSchemas.outputFiles,
  missingOutputs: RoundKeyedOutputSidecarValueSchemas.missingOutputs,
  compileFailures: RoundKeyedOutputSidecarValueSchemas.compileFailures,
});

const StreamViewSchema = z.discriminatedUnion('category', [
  ToolUseStreamViewSchema,
  WorkflowStreamViewSchema,
]);
export type StreamView = z.infer<typeof StreamViewSchema>;

/** A pending approval: which stream is asking, and the request the UI shows.
 *  The list is a set keyed by `requestId` (5.2). */
const ApprovalRequestSchema = z.object({
  streamId: StreamTabIdSchema,
  requestId: z.string(),
  payload: PermissionPayloadSchema,
});

const SessionViewSchema = z.object({
  key: SessionKeySchema,
  streams: z.map(StreamTabIdSchema, StreamViewSchema),
  /** Top-level ids, `streamOrdering` rule. */
  order: z.array(StreamTabIdSchema),
  /** The tail position: the last commit folded from `all`; a listing or
   *  history row never advances it. */
  cursor: CommitOrdinalSchema,
  /** One entry per subscribed aggregate: the highest seq the fold has
   *  retained for it (the subscription's `fromSeq` until a row folds).
   *  Created when the aggregate enters the subscription set, deleted with
   *  its transcript tier on eviction; never a commit ordinal. */
  folded: z.map(AggregateIdSchema, z.int().nonnegative()),
  /** One entry per `${aggregate}/${listing type}`: the commit of the latest
   *  listing fact folded for it, so a replayed older one is ignored. The
   *  lifecycle entry outlives its stream: it is what keeps a tombstone
   *  final when a read replays the `run.start` beneath it. */
  latest: z.map(z.string(), CommitOrdinalSchema),
  /** Live text per `${stream}/${row}`, beside the rows rather than inside
   *  them: a chunk can reach the fold before its row (5.2). A row paints
   *  its durable text joined with this entry; the entry goes when the row
   *  finalizes, the stream ends, the stream is removed, or its transcript
   *  tier is evicted. */
  inflight: z.map(z.string(), z.string()),
  /** Paper-level aggregate; a rail badge reads it and derives nothing. */
  rollup: z.object({
    running: z.int().nonnegative(),
    waiting: z.int().nonnegative(),
    interrupted: z.int().nonnegative(),
  }),
  approvals: z.array(ApprovalRequestSchema),
  /** Latest snapshot per run. */
  policy: z.map(StreamTabIdSchema, ApprovalPolicySnapshotSchema),
  inquiries: z.array(InquiryThreadUpdatedEventSchema),
  /** This process's local truth: a fold input, never durable. */
  local: z.object({
    self: z.array(OwnerIdSchema),
    heldBy: z.array(OwnerIdSchema),
    unreadable: z.array(
      z.object({ streamId: StreamTabIdSchema, detail: z.string() }),
    ),
  }),
  queuedFollowUps: z.map(StreamTabIdSchema, z.array(z.string())),
});
export type SessionView = z.infer<typeof SessionViewSchema>;

/**
 * The empty view a fold starts from: keyed by its session, its cursor at the
 * layer's tail anchor (PRD 7.2). Built once per fold fiber and never by an
 * input, since no arm carries a key.
 */
export function emptySessionView(key: string, cursor = 0): SessionView {
  return {
    key,
    streams: new Map(),
    order: [],
    cursor,
    folded: new Map(),
    latest: new Map(),
    inflight: new Map(),
    rollup: { running: 0, waiting: 0, interrupted: 0 },
    approvals: [],
    policy: new Map(),
    inquiries: [],
    local: { self: [], heldBy: [], unreadable: [] },
    queuedFollowUps: new Map(),
  };
}
