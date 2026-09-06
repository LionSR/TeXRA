/**
 * The fold's input vocabulary (.agents/docs/implemented/architecture/2026-09-03-prd-one-fold-three-renderers.md
 * sections 5.2 and 6): the durable session events every process folds into
 * `SessionView`, plus the transient arms (live text chunks, the local runtime
 * snapshot, the transcript subscription set, the replay marker) that never
 * carry a seq.
 *
 * Every durable arm rides one envelope: the aggregate it belongs to, its
 * per-aggregate `seq`, the session-wide `commit` ordinal, the process identity
 * of the writer, and the publish clock. The arms mirror the trace
 * (`AgentEvent`) shapes field for field where the fold reads them, so a
 * publisher translates by naming fields, never by re-encoding.
 *
 * Layering: this module lives under `src/shared/schemas` so the fold and the
 * transport stay free of `@agent/*` (`dependencyDirection.vitest.ts` keeps the
 * shared-to-agent allowlist empty).
 */
import { Result } from 'effect';
import { z } from 'zod';

import { parseJsonWith } from '@common/parsing/safeParseJson';

import { TexraApprovalPolicySchema } from '@shared/approvalPolicy';
import { AgentCategorySchema } from './agent';
import { ContextStateDataSchema } from './contextManagement';
import { GoalStateSchema } from './goal';
import { ExecutionIdSchema, StreamTabIdSchema } from './identifiers';
import { InquiryThreadUpdatedEventSchema } from './inquiry';
import { PlanSchema } from './plan';
import { PermissionPayloadSchema } from './progressView/data';
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
  ApprovalBypassesSchema,
  ConversationProgressSchema,
  RoundKeyedOutputSidecarValueSchemas,
} from './streamState';
import { StageKindSchema } from './taskGroup';
import { TodoItemSchema } from './todo';
import { ExtendedTokenUsageStatsSchema } from './usage';

/** C5's complete process identity, encoded canonically without losing null. */
const OwnerIdentitySchema = z.tuple([
  z.string().min(1),
  z.int().positive(),
  z.string().min(1).nullable(),
]);

/**
 * JSON.stringify([hostname.toLowerCase(), pid, processStart]). Host identity
 * is necessary: a missing local pid cannot prove a foreign process dead.
 */
export const OwnerIdSchema = z.string().refine(
  (value) =>
    Result.match(parseJsonWith(value, OwnerIdentitySchema), {
      onSuccess: (identity) =>
        identity[0] === identity[0].toLowerCase() &&
        JSON.stringify(identity) === value,
      onFailure: () => false,
    }),
  'Expected a canonical [hostname, pid, processStart] process identity',
);
export type OwnerId = z.infer<typeof OwnerIdSchema>;

/** Decode an owner already validated at the event or transport boundary. */
export function ownerIdentity(ownerId: OwnerId): {
  hostname: string;
  pid: number;
  processStart: string | null;
} {
  const [hostname, pid, processStart] = JSON.parse(ownerId) as z.infer<
    typeof OwnerIdentitySchema
  >;
  return { hostname, pid, processStart };
}

/** The recorded pid shown when another process holds a run. */
export function ownerPid(ownerId: OwnerId): number {
  return ownerIdentity(ownerId).pid;
}

/** C2 separates independent lifecycles even when their logical ids coincide. */
const AggregateKeySchema = z.tuple([
  z.enum([
    'stream',
    'execution',
    'workflow-checkpoint',
    'inquiry',
    'session',
    'migration',
  ]),
  z.string().min(1),
]);

/** The canonical JSON encoding of an aggregate kind and its logical id. */
export const AggregateIdSchema = z
  .string()
  .refine(
    (value) =>
      Result.match(parseJsonWith(value, AggregateKeySchema), {
        onSuccess: (key) => JSON.stringify(key) === value,
        onFailure: () => false,
      }),
    {
      error: 'Expected a canonical [kind, logicalId] aggregate key',
      abort: true,
    },
  )
  .brand<'AggregateId'>();
export type AggregateId = z.infer<typeof AggregateIdSchema>;

/** Qualify a logical id once. An already-qualified key is not an input. */
export function aggregateId(
  kind: z.infer<typeof AggregateKeySchema>[0],
  logicalId: string & { readonly [z.$brand]?: never },
): AggregateId {
  return AggregateIdSchema.parse(JSON.stringify([kind, logicalId]));
}

/** Decode a validated aggregate key at a logical-id boundary. */
export function aggregateTarget(key: AggregateId): {
  kind: z.infer<typeof AggregateKeySchema>[0];
  id: string;
} {
  const [kind, id] = JSON.parse(key) as z.infer<typeof AggregateKeySchema>;
  return { kind, id };
}

/** Per-aggregate append order; `run.start` is seq 1 of its stream. Dense
 *  from 1, assigned by the substrate's publisher and by nothing else. */
const SeqSchema = z.int().positive();

/** The session-wide insert ordinal a replay follows; zero is "before the
 *  first commit", the cursor an empty view starts from. */
export const CommitOrdinalSchema = z.int().nonnegative();
export type CommitOrdinal = z.infer<typeof CommitOrdinalSchema>;

/**
 * The full approval-policy snapshot after a change, emitted by the single
 * policy authority (`src/shared/approvalPolicy.ts`). Never a toggle delta:
 * the fold keeps the latest snapshot per run.
 */
export const ApprovalPolicySnapshotSchema = z.object({
  policy: TexraApprovalPolicySchema,
  bypasses: ApprovalBypassesSchema,
});
export type ApprovalPolicySnapshot = z.infer<
  typeof ApprovalPolicySnapshotSchema
>;

/**
 * The envelope every durable arm rides (contract C1). A run-scoped fact's
 * aggregate is its stream; an inquiry thread's aggregate is the thread id
 * (PRD 5.1: no sentinel stream id exists). `at` is the publish clock,
 * informational only; ordering is `seq` within an aggregate and `commit`
 * across them.
 */
const envelope = {
  aggregateId: AggregateIdSchema,
  seq: SeqSchema,
  commit: CommitOrdinalSchema,
  /** Owner of the process that appended the event; null on legacy imports. */
  ownerId: OwnerIdSchema.nullable(),
  /** The publish clock in whole milliseconds: C1 stores it in an `INTEGER`
   *  column of a `STRICT` table, so the vocabulary states that rule here and
   *  the substrate restates it nowhere. */
  at: z.int(),
};

function durable<T extends string, S extends z.ZodRawShape>(
  type: T,
  shape: S,
  kind: z.infer<typeof AggregateKeySchema>[0] = 'stream',
) {
  return z.object({
    ...envelope,
    aggregateId: AggregateIdSchema.refine(
      (key) => aggregateTarget(key).kind === kind,
      `Expected a ${kind} aggregate for ${type}`,
    ),
    type: z.literal(type),
    ...shape,
  });
}

/**
 * Per-stream launch facts. Existence fact: a stream exists iff its
 * `run.start` exists, once per incarnation, seq 1 of its aggregate (decision
 * 9). `identity` and `worktree` are nullish only on the legacy importer's
 * events (contract C3); live emitters always know them. `category`,
 * `isRemote`, and `userFollowUpSupport` are explicit on every run: the
 * launcher knows them for an agent, a process, and a workflow script alike,
 * and the fold reads them verbatim and derives nothing (PRD 6, item 6). The
 * initial approval-policy snapshot rides here rather than as its own event
 * (PRD 6, item 2): under the latest-of-type rule a run never edited would
 * otherwise have no policy entry, and on the payload it is atomic with the
 * stream's existence. `checkpointId` is a workflow run's resume anchor
 * (decision 9): a relaunch finds its journal by it, never by the run's ids.
 */
const RunStartEventSchema = durable('run.start', {
  executionId: ExecutionIdSchema,
  identity: RunIdentitySchema.nullish(),
  userFollowUpSupport: UserFollowUpSupportSchema,
  /** The `StreamView` discriminant: `toolUse` for an agent in tool-use mode
   *  and for a process stream, `workflow` for a workflow agent or script. */
  category: AgentCategorySchema,
  /** Agent-registry remoteness; false for a run with no registry entry. */
  isRemote: z.boolean(),
  worktree: WorktreeInfoSchema.nullish(),
  parentStreamId: StreamTabIdSchema.nullish(),
  /**
   * Launched in the background whoever is watching (a delegated child); the
   * launch fact half of the old `suppressViewSwitch`, which the frozen NDJSON
   * `setActiveStream` line still carries (PRD 6, item 5). Focus is never a
   * fact.
   */
  background: z.boolean().nullish(),
  /** The run's approval policy at launch, from the session's single authority. */
  approvalPolicy: ApprovalPolicySnapshotSchema.nullish(),
  /** Workflow-script runs: the checkpoint this run journals into. */
  checkpointId: z.string().min(1).nullish(),
});

/**
 * The durable arms. Run-scoped arms mirror `AgentEvent`
 * (`src/agent/trace/events.ts`); session-scoped arms mirror the session
 * facts with the payload flattened. `stream.removed` is the tombstone: the
 * last row of its aggregate, final (PRD 5.2, "Existence").
 */
const SessionEventSchema = z.discriminatedUnion('type', [
  RunStartEventSchema,
  /**
   * Every activation of a run, the first launch and each resume (PRD 6,
   * item 8): the frozen NDJSON `setActiveStream` line projects from this and
   * from nothing else. `run.start` is the creation fact and happens once.
   */
  durable('run.activate', {
    category: AgentCategorySchema,
    /** Agent-registry remoteness, carried only by a run with a registry
     *  entry: the frozen wire line omits it for a process, agent-CLI, or
     *  workflow-script child (PRD 10.3), and a fold reads `run.start`. */
    isRemote: z.boolean().nullish(),
    background: z.boolean(),
  }),
  durable('run.config', {
    executionId: ExecutionIdSchema,
    /** The persisted `AgentConfig`, narrowed to what the view shows. */
    config: z.looseObject({
      model: z.string().nullish(),
      instruction: z.string().nullish(),
      agent: z.string().nullish(),
      inputFiles: z.array(z.string()).nullish(),
    }),
  }),
  /** The run lifecycle's last word: emitted once nothing in the owning
   *  process can still write for the run. The phase is the `status` fact's
   *  (PRD 6, item 3); this arm says only that the lifecycle has ended. */
  durable('result', {
    outcome: RunOutcomeSchema,
    executionId: z.string(),
    category: AgentCategorySchema,
    isSubagent: z.boolean(),
    /** The failure's kind alone; its message stays in the runtime's log. */
    error: z.object({ kind: z.string() }).nullish(),
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
    kind: StageKindSchema.nullish(),
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
  durable('setParentStream', { parentStreamId: StreamTabIdSchema.nullable() }),
  durable('stream.removed', {}),
  durable('updateStreamDescription', { description: z.string() }),
  /** Goal is per stream; the fact carries the state so the fold never reads
   *  `GoalStore`. */
  durable('goalStateChanged', { state: GoalStateSchema }),
  /** Aggregate is the thread id; `parentStreamId` is the payload's edge. */
  durable(
    'inquiryThreadUpdated',
    InquiryThreadUpdatedEventSchema.shape,
    'inquiry',
  ),
  durable('updateQueuedFollowUps', { messages: z.array(z.string()) }),
  durable('approval.requested', {
    requestId: z.string(),
    /** What the UI shows (diff, command, question), never host handles. */
    payload: PermissionPayloadSchema,
  }),
  durable('approval.resolved', { requestId: z.string() }),
  durable('approval.policy', { snapshot: ApprovalPolicySnapshotSchema }),
  /**
   * One transcript row, in the recorder's persisted row format: the only
   * transcript-tier arm before the cutover. The trace's flow rows replace it
   * when the event table lands (`2026-09-04-agent-runtime-on-effect.md`,
   * section 2.1); the legacy importer normalizes old logs into the same arm
   * (decision 5). Subject to the residency rule: folded for subscribed
   * aggregates only (PRD 5.2).
   */
  durable('transcript.entry', { entry: StreamLogEntrySchema }),
]);
export type SessionEvent = z.infer<typeof SessionEventSchema>;

/**
 * What a publisher hands `SessionEvents.publish`: the body plus the aggregate
 * it lives on (contract C2). The publisher stamps the rest of the envelope
 * (`seq`, `commit`, `ownerId`, `at`) under its permit; no caller passes them.
 * `Omit` is distributed over the union so a draft keeps its arm.
 */
export type SessionEventDraft = SessionEvent extends infer E
  ? E extends unknown
    ? Omit<E, 'seq' | 'commit' | 'ownerId' | 'at'>
    : never
  : never;

/**
 * The listing types the fold keys `latest` by (PRD 5.1): every durable arm
 * but the transcript tier. The approval pair shares one entry because it
 * folds to one set, and the lifecycle pair (`run.start`, `stream.removed`)
 * shares one because it folds to one existence: a tombstone's commit then
 * outranks a replayed `run.start` below it, which is what makes the
 * tombstone final under every read (5.2, "Existence").
 */
export function listingTypeOf(event: SessionEvent): string | null {
  switch (event.type) {
    case 'transcript.entry':
      return null;
    case 'approval.requested':
    case 'approval.resolved':
      return 'approval';
    case 'run.start':
    case 'stream.removed':
      return 'lifecycle';
    default:
      return event.type;
  }
}

/**
 * The read that delivered a durable row (PRD 7.1): the cold listing, one
 * aggregate's history, or the tail. Only a tail row advances `cursor`.
 */
export const FoldEventSchema = z.object({
  _tag: z.literal('event'),
  read: z.enum(['listing', 'aggregate', 'all']),
  event: SessionEventSchema,
});

/**
 * A live text delta for one row, carrying its own offsets into the row's
 * in-flight text (PRD 5.2, "Live text"): the transient analogue of `seq`.
 * The fold ignores a chunk whose `to` is not past the text it holds,
 * otherwise truncates at `from` and appends, so a redelivery in any order is
 * a no-op, a `from: 0` chunk replaces the row, and two adjacent chunks merge
 * into one exactly. Never durable, never a seq.
 */
export const TextChunkSchema = z.object({
  _tag: z.literal('chunk'),
  streamId: StreamTabIdSchema,
  rowId: z.string(),
  from: z.int().nonnegative(),
  to: z.int().positive(),
  text: z.string(),
});
export type TextChunk = z.infer<typeof TextChunkSchema>;

/**
 * What this process knows that the events cannot say (PRD 5.2): its own
 * owner id, the owners whose lease this process may not touch (alive or
 * unprovable), and the streams whose run state it could not read. From the
 * runtime's lease reader on every change and on every subscribe. Transient
 * like a text chunk: a replay with no snapshot folds with everything empty,
 * so every ownerless run reads as interrupted until the runtime says
 * otherwise.
 */
export const LocalRuntimeStateSchema = z.object({
  self: z.array(OwnerIdSchema),
  heldBy: z.array(OwnerIdSchema),
  unreadable: z.array(
    z.object({ streamId: StreamTabIdSchema, detail: z.string() }),
  ),
});
export type LocalRuntimeState = z.infer<typeof LocalRuntimeStateSchema>;

/**
 * The aggregates whose transcript tier the view holds, each with the seq
 * its history is read from (PRD 5.2, "Residency"). Every value of the set
 * is a fold input: an aggregate entering it gets its `folded` entry, one
 * leaving it loses its transcript tier.
 */
export const TranscriptSubscriptionSchema = z.object({
  id: AggregateIdSchema,
  fromSeq: z.int().nonnegative(),
});
export type TranscriptSubscription = z.infer<
  typeof TranscriptSubscriptionSchema
>;

const FoldInputSchema = z.discriminatedUnion('_tag', [
  FoldEventSchema,
  TextChunkSchema,
  z.object({ _tag: z.literal('local'), local: LocalRuntimeStateSchema }),
  z.object({
    _tag: z.literal('subscriptions'),
    set: z.array(TranscriptSubscriptionSchema),
  }),
  /** The one marker of PRD 7.2: the sequenced cold reads have ended. It
   *  carries no fact and the fold does not fold it. */
  z.object({ _tag: z.literal('replay.complete') }),
  /** A finite tail read has completed, including rows no longer materialized. */
  z.object({ _tag: z.literal('drained'), cursor: CommitOrdinalSchema }),
]);
export type FoldInput = z.infer<typeof FoldInputSchema>;
