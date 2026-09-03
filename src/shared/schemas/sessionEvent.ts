/**
 * The fold's input vocabulary (docs/prds/2026-09-03-prd-one-fold-three-renderers.md
 * sections 5.2 and 6): the durable session events every process folds into
 * `SessionView`, plus the two transient arms (live text chunks and the owner
 * liveness snapshot) that never carry a seq.
 *
 * Every durable arm rides one envelope: the stream it belongs to, its
 * per-stream `seq`, the lease owner token of the process that appended it,
 * and the append timestamp. The arms mirror the trace (`AgentEvent`) and hub
 * (`SessionFact`) shapes field for field where the fold reads them, so a
 * publisher translates by naming fields, never by re-encoding.
 *
 * Layering: this module lives under `src/shared/schemas` so the fold and the
 * transport stay free of `@agent/*` (`dependencyDirection.vitest.ts` keeps the
 * shared-to-agent allowlist empty). `OwnerId` is the lease owner token
 * (`ExecutionLeaseSchema.ownerToken` in `src/agent/storage/executionLease.ts`,
 * a UUID); the two schemas cannot share a definition across that boundary, so
 * the shape is pinned here and the lease writer is the mint.
 */
import { z } from 'zod';

import { APPROVAL_BYPASS_KINDS } from '@shared/approvalBypassKind';
import { TexraApprovalPolicySchema } from '@shared/approvalPolicy';
import { AgentCategorySchema } from './agent';
import { ContextStateDataSchema } from './contextManagement';
import { GoalStateSchema } from './goal';
import { ExecutionIdSchema, StreamTabIdSchema } from './identifiers';
import { InquiryThreadUpdatedEventSchema } from './inquiry';
import { PlanSchema } from './plan';
import { PermissionPayloadSchema } from './progressView/outbound';
import { RunIdentitySchema } from './runIdentity';
import {
  RunOutcomeSchema,
  StreamPhaseSchema,
  StreamSubstateSchema,
  UserFollowUpSupportSchema,
  WorktreeInfoSchema,
} from './stream';
import { StreamLogEntrySchema } from './streamLogEntry';
import {
  ConversationProgressSchema,
  RoundKeyedOutputSidecarValueSchemas,
} from './streamState';
import { TodoItemSchema } from './todo';
import { ExtendedTokenUsageStatsSchema } from './usage';
import {
  WorkflowCallProgressSchema,
  WorkflowDeclaredPlanSchema,
} from './workflowCallProgress';

/** Lease owner token of a TeXRA process: `ExecutionLeaseSchema.ownerToken`. */
const OwnerIdSchema = z.uuid();

/**
 * The full approval-policy snapshot after a change, emitted by the single
 * policy authority (`src/shared/approvalPolicy.ts`). Never a toggle delta:
 * the fold keeps the latest snapshot per run.
 */
export const ApprovalPolicySnapshotSchema = z.object({
  policy: TexraApprovalPolicySchema,
  bypasses: z.record(z.enum(APPROVAL_BYPASS_KINDS), z.boolean()),
});

/**
 * The envelope every durable arm rides. The stream id lives here, so arms
 * never repeat it; session-scoped facts name the stream they are about.
 */
const envelope = {
  streamId: StreamTabIdSchema,
  /** Per-stream append order: the `(stream_id, seq)` key of the event table. */
  seq: z.int().positive(),
  /** Owner of the process that appended the event; null on legacy imports. */
  ownerId: OwnerIdSchema.nullable(),
  timestamp: z.number(),
};
type Envelope = { [K in keyof typeof envelope]: z.infer<(typeof envelope)[K]> };

function durable<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.object({ ...envelope, type: z.literal(type), ...shape });
}

/**
 * Per-stream launch facts. Existence fact: a stream exists iff its
 * `run.start` exists. `identity` is nullish only on the legacy importer's
 * events; live emitters always know it. Category, remoteness, and worktree
 * are launch facts the fold reads verbatim and never derives (PRD 6, item 6).
 */
const RunStartEventSchema = durable('run.start', {
  executionId: ExecutionIdSchema,
  identity: RunIdentitySchema.nullish(),
  userFollowUpSupport: UserFollowUpSupportSchema.nullish(),
  /** Agent runs only; a process stream has no category. */
  agentCategory: AgentCategorySchema.nullish(),
  isRemote: z.boolean().nullish(),
  worktree: WorktreeInfoSchema.nullish(),
  parentStreamId: StreamTabIdSchema.nullish(),
});

/**
 * The durable arms. Run-scoped arms mirror `AgentEvent`
 * (`src/agent/trace/events.ts`); session-scoped arms mirror `SessionFact`
 * (`src/agent/runtime/SessionEventHub.ts`) with the payload flattened.
 */
const SessionEventSchema = z.discriminatedUnion('type', [
  RunStartEventSchema,
  durable('run.config', {
    executionId: ExecutionIdSchema,
    /** The persisted `AgentConfig`, narrowed to what the view shows. */
    config: z.looseObject({
      model: z.string().nullish(),
      instruction: z.string().nullish(),
      workingDirectory: z.string().nullish(),
    }),
  }),
  /** Terminal outcome; the PRD's `run.end` is this arm. */
  durable('result', {
    outcome: RunOutcomeSchema,
    executionId: z.string(),
    category: AgentCategorySchema,
    isSubagent: z.boolean(),
    error: z
      .looseObject({ kind: z.string(), message: z.string().nullish() })
      .nullish(),
  }),
  durable('status', {
    phase: StreamPhaseSchema,
    previousPhase: StreamPhaseSchema.nullish(),
    /** `STREAM_TRANSITION_CAUSE` (`@shared/streams/streamStatus`); diagnostic,
     *  not a fold input. */
    cause: z.string(),
    substate: StreamSubstateSchema.nullish(),
    runStartedAt: z.int().positive().nullish(),
  }),
  /** The fields `streamStageFromStageStart` reads. */
  durable('stage.start', {
    id: z.string(),
    label: z.string(),
    parentId: z.string().nullish(),
    kind: z.enum(['run', 'round', 'phase', 'session']).nullish(),
    index: z.int().nonnegative().nullish(),
    total: z.int().nonnegative().nullish(),
  }),
  durable('conversation.progress', { progress: ConversationProgressSchema }),
  durable('usage', {
    storageKey: ExecutionIdSchema,
    usage: ExtendedTokenUsageStatsSchema,
  }),
  durable('context.state', {
    inputTokens: ContextStateDataSchema.shape.inputTokens,
    contextWindow: ContextStateDataSchema.shape.contextWindow,
  }),
  durable('updateTodos', { todos: z.array(TodoItemSchema) }),
  durable('updatePlan', { plan: PlanSchema.nullable() }),
  durable('addOutputFiles', {
    filesByRound: RoundKeyedOutputSidecarValueSchemas.outputFiles,
  }),
  durable('updateMissingOutputs', {
    filesByRound: RoundKeyedOutputSidecarValueSchemas.missingOutputs,
  }),
  durable('updateCompileFailures', {
    filesByRound: RoundKeyedOutputSidecarValueSchemas.compileFailures,
  }),
  durable('goalPaused', {}),
  durable('workflow.call', {
    logId: z.string(),
    call: WorkflowCallProgressSchema,
  }),
  durable('workflow.plan', {
    attemptId: z.string().min(1),
    ...WorkflowDeclaredPlanSchema.shape,
  }),
  durable('setParentStream', { parentStreamId: StreamTabIdSchema.nullable() }),
  durable('removeStream', {}),
  durable('updateStreamDescription', { description: z.string() }),
  /** Goal is per stream; the fact carries the state so the fold never reads
   *  `GoalStore`. */
  durable('goalStateChanged', { state: GoalStateSchema }),
  durable('inquiryThreadUpdated', InquiryThreadUpdatedEventSchema.shape),
  durable('updateQueuedFollowUps', { messages: z.array(z.string()) }),
  durable('approval.requested', {
    requestId: z.string(),
    /** What the UI shows (diff, command, question), never host handles. */
    payload: PermissionPayloadSchema,
  }),
  durable('approval.resolved', { requestId: z.string() }),
  durable('approval.policy', { snapshot: ApprovalPolicySnapshotSchema }),
  /** An imported transcript row; the fold keeps this arm until retention
   *  removes the last legacy stream. */
  durable('legacy.entry', { entry: StreamLogEntrySchema }),
]);
export type SessionEvent = z.infer<typeof SessionEventSchema>;

/** A durable arm without its envelope: what an in-process publisher builds
 *  before the seq, owner, and timestamp are stamped on. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
export type SessionEventBody = DistributiveOmit<SessionEvent, keyof Envelope>;

/** The `run.start` payload the trace's `RunStartEvent` is typed from. */
export type RunStartEventBody = Extract<
  SessionEventBody,
  { type: 'run.start' }
>;

/** A live text delta for one streaming row; never durable, never a seq. */
const TextChunkSchema = z.object({
  type: z.literal('text.chunk'),
  streamId: StreamTabIdSchema,
  entryId: z.string(),
  chunkIndex: z.int().nonnegative(),
  text: z.string(),
});

/**
 * The set of owner ids whose process is alive, from the runtime's lease
 * reader on every change and on every subscribe. Transient like a text chunk:
 * a replay with no snapshot folds with no live owners, so every pending
 * approval reads as interrupted until the runtime says otherwise.
 */
const OwnerLivenessSnapshotSchema = z.object({
  type: z.literal('owner.liveness'),
  owners: z.array(OwnerIdSchema),
});

const FoldInputSchema = z.union([
  SessionEventSchema,
  TextChunkSchema,
  OwnerLivenessSnapshotSchema,
]);
export type FoldInput = z.infer<typeof FoldInputSchema>;
