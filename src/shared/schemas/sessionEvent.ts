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
 * One run owns one aggregate, `('run', runId)` (one run model, section 3.1):
 * display rows and the run's private records land on the same aggregate, and
 * whether a row reaches a renderer is a property of its type
 * (`isDisplaySessionEvent`), not of a second aggregate.
 *
 * Layering: this module lives under `src/shared/schemas` so the fold and the
 * transport stay free of `@agent/*` (`dependencyDirection.vitest.ts` keeps the
 * shared-to-agent allowlist empty).
 */
import { Result } from 'effect';
import { z } from 'zod';

import { parseJsonWith } from '@common/parsing/safeParseJson';

import { TexraApprovalPolicySchema } from '@shared/approvalPolicy';
import { UpdateCheckRecordSchema } from './updateCheck';
import { AgentCategorySchema } from './agent';
import { AgentConfigFieldsSchema } from './agentConfig';
import { GoalStateSchema } from './goal';
import {
  RunRecordFieldsSchema,
  RunWorkspaceFilesSchema,
  ResultMetaSchema,
} from './runRecords';
import { WorkflowRunSnapshotSchema } from './workflowRunSnapshot';
import { RunIdSchema, type RunId } from './identifiers';
import {
  InquiryThreadRecordSchema,
  InquiryThreadUpdatedEventSchema,
} from './inquiry';
import { PlanSchema } from './plan';
import { PermissionPayloadSchema } from './progressView/data';
import { RunIdentitySchema } from './runIdentity';
import {
  RunPhaseSchema,
  RunSubstateSchema,
  UserFollowUpSupportSchema,
  WorktreeInfoSchema,
} from './run';
import { StreamLogEntrySchema } from './streamLogEntry';
import {
  ApprovalBypassesSchema,
  ConversationProgressSchema,
  RoundKeyedOutputSidecarValueSchemas,
} from './runState';
import { TodoItemSchema } from './todo';
import { ResultEventSchema, TranscriptEventSchemas } from './traceEvent';

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

/**
 * C2 separates independent lifecycles even when their logical ids coincide.
 * `run` is keyed by the run id; every other kind by its own logical id.
 */
const AggregateKindSchema = z.enum([
  'run',
  'workflow-checkpoint',
  'inquiry',
  'session',
  'desktop-projects',
  'global-inquiry',
  'update-check',
]);
type AggregateKind = z.infer<typeof AggregateKindSchema>;
const AggregateKeySchema = z
  .tuple([AggregateKindSchema, z.string().min(1)])
  .refine(
    ([kind, id]) => kind !== 'run' || RunIdSchema.safeParse(id).success,
    'A run aggregate is keyed by a run id',
  );

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

/** A logical id that is not itself an already-qualified aggregate key. */
type LogicalId = string & {
  readonly [z.$brand]?: { readonly AggregateId?: never };
};

/** Qualify a logical id once. An already-qualified key is not an input. */
export function aggregateId(kind: 'run', logicalId: RunId): AggregateId;
export function aggregateId(
  kind: Exclude<AggregateKind, 'run'>,
  logicalId: LogicalId,
): AggregateId;
export function aggregateId(
  kind: AggregateKind,
  logicalId: string,
): AggregateId {
  return AggregateIdSchema.parse(JSON.stringify([kind, logicalId]));
}

/** A decoded aggregate key: the `run` arm carries its logical id as a `RunId`. */
export type AggregateTarget =
  | { readonly kind: 'run'; readonly id: RunId }
  | { readonly kind: Exclude<AggregateKind, 'run'>; readonly id: string };

/** Decode a validated aggregate key at a logical-id boundary. */
export function aggregateTarget(key: AggregateId): AggregateTarget {
  const [kind, id] = JSON.parse(key) as z.infer<typeof AggregateKeySchema>;
  return kind === 'run' ? { kind, id: RunIdSchema.parse(id) } : { kind, id };
}

/** Per-aggregate append order; `run.start` is seq 1 of its run. Dense from
 *  1, assigned by the substrate's publisher and by nothing else. */
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
 * aggregate is its run; an inquiry thread's aggregate is the thread id
 * (PRD 5.1: no sentinel run id exists). `at` is the publish clock,
 * informational only; ordering is `seq` within an aggregate and `commit`
 * across them.
 */
const envelope = {
  seq: SeqSchema,
  commit: CommitOrdinalSchema,
  /** Owner of the process that appended the event; null for the trace
   *  viewer's reconstruction, which has no owning process. */
  ownerId: OwnerIdSchema.nullable(),
  /** The publish clock in whole milliseconds: C1 stores it in an `INTEGER`
   *  column of a `STRICT` table, so the vocabulary states that rule here and
   *  the substrate restates it nowhere. */
  at: z.int(),
};

function durable<T extends string, S extends z.ZodRawShape>(
  type: T,
  shape: S,
  kind: AggregateKind = 'run',
) {
  return z.object({
    aggregateId: AggregateIdSchema.refine(
      (key) => aggregateTarget(key).kind === kind,
      `Expected a ${kind} aggregate for ${type}`,
    ),
    stageId: z.string().optional(),
    type: z.literal(type),
    ...shape,
  });
}

/**
 * The parent edge (one run model, section 3.2): the whole of it. `id` is the
 * launching run; `startCommit` is that run's creation commit, stamped by the
 * database inside the child's creation transaction so a logical id a
 * workflow-script retry reuses can never redirect the child to a later
 * incarnation of its parent. Everything else that used to spell the edge
 * (`parentStreamId`, `parentExecutionId`, `isSubagent`,
 * `background`) is `parent !== null`, computed from the fold or the handle.
 */
const RunParentSchema = z.object({
  id: RunIdSchema,
  startCommit: z.int().positive(),
});
export type RunParent = z.infer<typeof RunParentSchema>;

/**
 * Per-run launch facts. Existence fact: a run exists iff its `run.start`
 * exists, once per incarnation, seq 1 of its aggregate (decision 9); the
 * aggregate's logical id is the run id, so the row carries no second copy of
 * it. `worktree` is absent for a run that executes in the workspace itself
 * rather than in a dedicated worktree. `category`,
 * `isRemote`, and `userFollowUpSupport` are explicit on every run: the
 * launcher knows them for an agent, a process, and a workflow script alike,
 * and the fold reads them verbatim and derives nothing (PRD 6, item 6). The
 * initial approval-policy snapshot rides here rather than as its own event
 * (PRD 6, item 2): under the latest-of-type rule a run never edited would
 * otherwise have no policy entry, and on the payload it is atomic with the
 * run's existence. `checkpointId` is a workflow run's resume anchor
 * (decision 9): a relaunch finds its journal by it, never by the run's id.
 */
const RunStartEventSchema = durable('run.start', {
  identity: RunIdentitySchema,
  userFollowUpSupport: UserFollowUpSupportSchema,
  /** The `RunView` discriminant: `toolUse` for an agent in tool-use mode
   *  and for a process run, `workflow` for a workflow agent or script. */
  category: AgentCategorySchema,
  /** Agent-registry remoteness; false for a run with no registry entry. */
  isRemote: z.boolean(),
  worktree: WorktreeInfoSchema.nullish(),
  /** The launching run with its creation coordinate; null for a root. */
  parent: RunParentSchema.nullable(),
  /** The run's approval policy at launch, from the session's single authority. */
  approvalPolicy: ApprovalPolicySnapshotSchema.nullish(),
  /** Workflow-script runs: the checkpoint this run journals into. */
  checkpointId: z.string().min(1).nullish(),
});

/** C9 cleanup targets: the run directories owned by this lifecycle, derived by the database. */
const RunRemovedEventSchema = durable('run.removed', {
  runIds: z.array(RunIdSchema),
});

/** A launcher names the parent; the database stamps its creation commit. */
const RunStartDraftSchema = RunStartEventSchema.omit({ parent: true }).extend({
  parent: RunParentSchema.pick({ id: true }).nullable(),
});
const RunRemovedDraftSchema = RunRemovedEventSchema.omit({
  runIds: true,
});

/**
 * The durable arms every renderer folds. Run-scoped arms mirror `AgentEvent`
 * (`src/agent/trace/events.ts`); session-scoped arms mirror the session
 * facts with the payload flattened. `run.removed` is the tombstone: the
 * last row of its aggregate, final (PRD 5.2, "Existence").
 */
const DisplaySessionEventDraftSchema = z.discriminatedUnion('type', [
  RunStartDraftSchema,
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
  }),
  durable('run.config', {
    /** The canonical configuration, validated before it becomes durable. */
    config: AgentConfigFieldsSchema,
  }),
  /**
   * The parent edge severed: a child promoted to the top level by a stop
   * that detaches its children. The only fact after `run.start` that moves
   * the edge; a run never acquires a new parent.
   */
  durable('run.detach', {}),
  /** The run lifecycle's last word: emitted once nothing in the owning
   *  process can still write for the run. The phase is the `status` fact's
   *  (PRD 6, item 3); this arm says only that the lifecycle has ended. */
  durable(
    'result',
    ResultEventSchema.unwrap().omit({ type: true, runId: true }).shape,
  ),
  durable('status', {
    phase: RunPhaseSchema,
    previousPhase: RunPhaseSchema.nullish(),
    /** `RUN_TRANSITION_CAUSE` (`@shared/runs/runStatus`); diagnostic,
     *  not a fold input. */
    cause: z.string(),
    substate: RunSubstateSchema.nullish(),
    runStartedAt: z.int().positive().nullish(),
  }),
  durable('conversation.progress', { progress: ConversationProgressSchema }),
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
  RunRemovedDraftSchema,
  durable('updateRunDescription', { description: z.string() }),
  /** Goal is per run; the fact carries the state so the fold never reads
   *  `GoalStore`. */
  durable('goalStateChanged', { state: GoalStateSchema }),
  /** Aggregate is the thread id; `parentRunId` is the payload's edge. */
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
   * section 2.1). Subject to the residency rule: folded for subscribed
   * aggregates only (PRD 5.2).
   */
  durable('transcript.entry', { entry: StreamLogEntrySchema }),
  ...Object.values(TranscriptEventSchemas).map((schema) =>
    schema.extend({
      /** Stamped at publication (`SessionHandle.publish`), so a draft does
       * not carry it. */
      transcriptDebug: z.boolean().optional(),
      aggregateId: AggregateIdSchema.refine(
        (key) => aggregateTarget(key).kind === 'run',
        `Expected a run aggregate for ${schema.shape.type.value}`,
      ),
    }),
  ),
]);
/**
 * The run's private records: on the same aggregate as its display rows, read
 * by the runtime's typed accessors and never by a renderer
 * (`isDisplaySessionEvent` keeps them out of the transport by type).
 */
const RunRecordEventDraftSchema = z.discriminatedUnion('type', [
  durable('run.record', { record: RunRecordFieldsSchema }),
  durable('run.launchLabel', { label: z.string() }),
  durable('run.description', { description: z.string() }),
  durable('run.report', { report: z.string().nullable() }),
  durable('run.result', { result: ResultMetaSchema }),
  durable('run.workspaceFiles', { paths: RunWorkspaceFilesSchema }),
  durable('run.workflow', { workflow: WorkflowRunSnapshotSchema }),
]);
const DesktopProjectsDraftSchema = durable(
  'desktop.projects.changed',
  { roots: z.array(z.string().min(1)) },
  'desktop-projects',
);
const GlobalInquiryDraftSchema = durable(
  'inquiry.recorded',
  { record: InquiryThreadRecordSchema },
  'global-inquiry',
);
const UpdateCheckDraftSchema = durable(
  'update.check.recorded',
  { record: UpdateCheckRecordSchema },
  'update-check',
);
export const SessionEventDraftSchema = z.discriminatedUnion('type', [
  ...DisplaySessionEventDraftSchema.options,
  ...RunRecordEventDraftSchema.options,
  DesktopProjectsDraftSchema,
  GlobalInquiryDraftSchema,
  UpdateCheckDraftSchema,
]);
const DisplaySessionEventSchema = z.discriminatedUnion('type', [
  RunStartEventSchema.extend(envelope),
  RunRemovedEventSchema.extend(envelope),
  ...DisplaySessionEventDraftSchema.options
    .filter(
      (
        schema,
      ): schema is Exclude<
        typeof schema,
        typeof RunStartDraftSchema | typeof RunRemovedDraftSchema
      > =>
        schema.shape.type.value !== 'run.start' &&
        schema.shape.type.value !== 'run.removed',
    )
    .map((schema) => schema.extend(envelope)),
]);
export type DisplaySessionEventDraft = z.infer<
  typeof DisplaySessionEventDraftSchema
>;
export type DisplaySessionEvent = z.infer<typeof DisplaySessionEventSchema>;
export const SessionEventSchema = z.discriminatedUnion('type', [
  ...DisplaySessionEventSchema.options,
  ...RunRecordEventDraftSchema.options.map((schema) => schema.extend(envelope)),
  DesktopProjectsDraftSchema.extend(envelope),
  GlobalInquiryDraftSchema.extend(envelope),
  UpdateCheckDraftSchema.extend(envelope),
]);
export type SessionEvent = z.infer<typeof SessionEventSchema>;

/**
 * What a publisher hands `SessionEvents.publish`: the body plus the aggregate
 * it lives on (contract C2). The publisher stamps the rest of the envelope
 * (`seq`, `commit`, `ownerId`, `at`) under its permit; no caller passes them.
 * Parsing a draft removes caller-supplied envelope fields before storage.
 */
export type SessionEventDraft = z.infer<typeof SessionEventDraftSchema>;

/** Aggregate identities introduced by a fact and its declared lifecycle edges. */
export function referencedAggregates(event: SessionEvent): AggregateId[] {
  const ids = [event.aggregateId];
  if (event.type === 'run.start') {
    if (event.parent !== null) ids.push(aggregateId('run', event.parent.id));
    if (event.checkpointId != null)
      ids.push(aggregateId('workflow-checkpoint', event.checkpointId));
  }
  if (event.type === 'inquiryThreadUpdated' && event.parentRunId !== null) {
    ids.push(aggregateId('run', event.parentRunId));
  }
  return ids;
}

/**
 * The listing types the fold keys `latest` by (PRD 5.1): every durable arm
 * but the transcript tier. The approval pair shares one entry because it
 * folds to one set, and the lifecycle pair (`run.start`, `run.removed`)
 * shares one because it folds to one existence: a tombstone's commit then
 * outranks a replayed `run.start` below it, which is what makes the
 * tombstone final under every read (5.2, "Existence").
 */
export function listingTypeOf(
  event: Pick<SessionEvent, 'type'>,
): string | null {
  switch (event.type) {
    case 'transcript.entry':
    case 'log':
    case 'stage.end':
    case 'tool.start':
    case 'tool.end':
    case 'workflow.plan':
    case 'workflow.call':
    case 'skills.snapshot':
    case 'stream.start':
    case 'stream.end':
    case 'response.finalized':
    case 'domain':
      return null;
    case 'approval.requested':
    case 'approval.resolved':
      return 'approval';
    case 'run.start':
    case 'run.removed':
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
  event: DisplaySessionEventSchema,
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
  runId: RunIdSchema,
  rowId: z.string(),
  from: z.int().nonnegative(),
  to: z.int().positive(),
  text: z.string(),
});
export type TextChunk = z.infer<typeof TextChunkSchema>;

/**
 * Process-local liveness evidence: self, explicitly proved-dead owners, and
 * unreadable runs. A current claimant absent from these verdicts is
 * unprovable and remains held until a probe establishes otherwise.
 */
export const LocalRuntimeStateSchema = z.object({
  self: z.array(OwnerIdSchema),
  dead: z.array(OwnerIdSchema),
  unreadable: z.array(z.object({ runId: RunIdSchema, detail: z.string() })),
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

/** Current ownership and removals for exactly the scope checked by a finite read. */
export const ExistenceReconciliationSchema = z.object({
  checkedAggregateIds: z.array(AggregateIdSchema),
  removedAggregateIds: z.array(AggregateIdSchema),
  claims: z.array(
    z.object({
      aggregateId: AggregateIdSchema,
      ownerId: OwnerIdSchema.nullable(),
    }),
  ),
});
export type ExistenceReconciliation = z.infer<
  typeof ExistenceReconciliationSchema
>;

const FoldInputSchema = z.discriminatedUnion('_tag', [
  FoldEventSchema,
  TextChunkSchema,
  z.object({ _tag: z.literal('local'), local: LocalRuntimeStateSchema }),
  z.object({
    _tag: z.literal('subscriptions'),
    set: z.array(TranscriptSubscriptionSchema),
  }),
  /** Cold reads have completed; apply current claims without adopting a later cursor. */
  z.object({
    _tag: z.literal('replay.complete'),
    existence: ExistenceReconciliationSchema,
  }),
  /** A finite tail read has completed, including rows no longer materialized. */
  z.object({
    _tag: z.literal('drained'),
    cursor: CommitOrdinalSchema,
    existence: ExistenceReconciliationSchema,
  }),
]);
export type FoldInput = z.infer<typeof FoldInputSchema>;

const DISPLAY_EVENT_TYPES = new Set<string>(
  DisplaySessionEventDraftSchema.options.map(
    (schema) => schema.shape.type.value,
  ),
);

/** A run's private records and the profile-state rows never enter display transport. */
export function isDisplaySessionEvent(
  event: SessionEvent,
): event is DisplaySessionEvent {
  return DISPLAY_EVENT_TYPES.has(event.type);
}
