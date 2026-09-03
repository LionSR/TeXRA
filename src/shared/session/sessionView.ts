/**
 * The one session state every renderer reads (PRD one-fold-three-renderers,
 * section 5.1). Fold output, never persisted, never parsed: the schema is the
 * type's single source of truth, so a field lands here first and every host
 * reads the same name.
 *
 * Every field is Zod except `transcript`: its rows, task groups, compaction
 * blocks, and run model are the existing shared folds' TypeScript outputs
 * (`TranscriptRow` carries `ReadonlyMap`s), and fold output never crosses a
 * parse boundary (G1, G2), so `z.custom<TranscriptView>()` states the type
 * without inventing a second definition of those shapes.
 *
 * Interaction state (selection, drafts, recording, expansion, focus, scroll)
 * is never here (G3); `sessionPresentationBoundary.vitest.ts` pins the names.
 */
import { z } from 'zod';

import {
  AgentCategory,
  ApprovalPolicySnapshotSchema,
  ContextStateDataSchema,
  ConversationProgressSchema,
  ExecutionIdSchema,
  GoalStateSchema,
  InquiryThreadUpdatedEventSchema,
  PermissionPayloadSchema,
  PlanSchema,
  RoundKeyedOutputSidecarValueSchemas,
  RunIdentitySchema,
  RunUsageMapSchema,
  StreamLifecycleStatusSchema,
  StreamStageSchema,
  StreamSubstateSchema,
  StreamTabIdSchema,
  TodoItemSchema,
  UserFollowUpSupportSchema,
  WorktreeInfoSchema,
  type TaskGroup,
} from '@shared/schemas';
import type { TranscriptRow } from '@shared/transcript';
import type { CompactionActivityProjection } from '@shared/streams/compactionActivityProjection';
import { STREAM_STATUS_TONE } from '@shared/streams/streamStatusDisplay';
import type { WorkflowRunModel } from '@shared/streams/workflowRunModel';

/**
 * A stream's transcript slice: what hosts paint, and nothing else. The fold
 * keeps its incremental indexes (row and group positions, the compaction
 * projection's working state, live-text cursors, the newest plan marker)
 * beside the value in a module-private map, so a host can neither depend on
 * nor mutate them. `rows`, `taskGroups`, and `compaction` are appended in
 * place by the fold (a copy per entry would make a replay quadratic) and the
 * slice value is replaced on every change; hosts read, never write.
 */
export interface TranscriptView {
  /** `projectTranscriptRow` over every entry plus the compaction rows, in
   *  wire append order. */
  readonly rows: TranscriptRow[];
  /** `upsertTaskGroupFromStreamLog` over the group entries. */
  readonly taskGroups: TaskGroup[];
  /** `applyCompactionActivityEntries` blocks, in projection order. */
  readonly compaction: CompactionActivityProjection['blocks'];
  /** The last durable seq folded into this stream; text chunks never move it. */
  readonly settledSeq: number;
  /** `workflowRunModel`, for a workflow-script run; null for every other. */
  readonly run: WorkflowRunModel | null;
}

const StreamGroupSchema = z.enum(['running', 'waiting', 'recent']);

const StreamViewCommonSchema = z.object({
  id: StreamTabIdSchema,
  /** Null only for legacy imports. */
  identity: RunIdentitySchema.nullable(),
  executionId: ExecutionIdSchema.nullable(),
  // Launch facts from the `run.start` payload, never derived (5.2).
  isRemote: z.boolean(),
  /** Owner of the latest durable event. */
  ownerId: z.string().nullable(),
  /** Agent name, or the id-prefix fallback for an identity-less stream. */
  label: z.string(),
  /** The AI one-liner; title when present. */
  description: z.string().nullable(),
  model: z.string().nullable(),
  modelLabel: z.string().nullable(),
  /** Full, untruncated command that spawned a process stream. */
  command: z.string().nullable(),
  worktree: WorktreeInfoSchema.nullable(),
  /** The durable phase. An interrupted stream (a pending approval with no
   *  live owner, 5.2) keeps it and reads as interrupted through the copy. */
  status: StreamLifecycleStatusSchema,
  substate: StreamSubstateSchema.nullable(),
  /** Banner copy beside the label: the interrupted reading's resume notice;
   *  null otherwise. */
  statusDetail: z.string().nullable(),
  // G4: one table (`streamStatusDisplay`) spells both, through the status
  // and substate or the interrupted reading.
  statusLabel: z.string(),
  tone: z.enum(STREAM_STATUS_TONE),
  runStartedAt: z.int().positive().nullable(),
  lastTimestamp: z.number().nullable(),
  /** The first `run.start` timestamp: the ordering key. A resume keeps it. */
  creationTimestamp: z.number(),
  conversationProgress: ConversationProgressSchema,
  stage: StreamStageSchema.nullable(),
  followUpSupport: UserFollowUpSupportSchema,
  contextState: ContextStateDataSchema.nullable(),
  parentId: StreamTabIdSchema.nullable(),
  /** Root first; an evicted parent keeps its last known label. */
  ancestors: z.array(z.object({ id: StreamTabIdSchema, label: z.string() })),
  /** `streamOrdering` rule. */
  childIds: z.array(StreamTabIdSchema),
  /** Descendants by status. No waiting count: a waiting descendant expands
   *  the path, so a collapsed parent never hides one. */
  rollup: z.object({
    total: z.int().nonnegative(),
    running: z.int().nonnegative(),
    finished: z.int().nonnegative(),
  }),
  approval: z.enum(['none', 'own', 'descendant']),
  group: StreamGroupSchema,
  usage: RunUsageMapSchema,
  transcript: z.custom<TranscriptView>(),
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

/** A pending approval: which stream is asking, and the request the UI shows. */
const ApprovalRequestSchema = z.object({
  streamId: StreamTabIdSchema,
  requestId: z.string(),
  payload: PermissionPayloadSchema,
});

const SessionViewSchema = z.object({
  streams: z.map(StreamTabIdSchema, StreamViewSchema),
  /** Top-level ids, `streamOrdering` rule. */
  order: z.array(StreamTabIdSchema),
  approvals: z.array(ApprovalRequestSchema),
  /** Latest snapshot per run. */
  policy: z.map(StreamTabIdSchema, ApprovalPolicySnapshotSchema),
  inquiries: z.array(InquiryThreadUpdatedEventSchema),
  /** Owner ids whose process is alive: a fold input, never persisted. */
  liveOwners: z.array(z.string()),
  queuedFollowUps: z.map(StreamTabIdSchema, z.array(z.string())),
});
export type SessionView = z.infer<typeof SessionViewSchema>;

/** The empty view a fold starts from. */
export function createSessionView(): SessionView {
  return {
    streams: new Map(),
    order: [],
    approvals: [],
    policy: new Map(),
    inquiries: [],
    liveOwners: [],
    queuedFollowUps: new Map(),
  };
}
