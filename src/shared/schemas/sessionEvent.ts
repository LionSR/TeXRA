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
  RunEndSchema,
  RunRecordFieldsSchema,
  RunWorkspaceFilesSchema,
  ResultMetaSchema,
} from './runRecords';
import { RunIdSchema, type RunId } from './identifiers';
import { JsonValueSchema } from './jsonValue';
import { WorkflowScriptFilesSchema } from './workflowScriptFiles';
import {
  InquiryThreadRecordSchema,
  InquiryThreadUpdatedEventSchema,
} from './inquiry';
import { PlanSchema } from './plan';
import { PermissionPayloadSchema } from './progressView/data';
import { RequestDecisionSchema } from './request';
import { RunIdentitySchema } from './runIdentity';
import {
  FlowSnapshotPayloadSchema,
  FlowStepPayloadSchema,
  ModelCompactionPayloadSchema,
  ModelMessagePayloadSchema,
  ToolIntentPayloadSchema,
  ToolResultPayloadSchema,
} from './runLedgerEvent';
import { UserFollowUpSupportSchema, WorktreeInfoSchema } from './run';
import {
  ApprovalBypassesSchema,
  ConversationProgressSchema,
  RoundKeyedOutputSidecarValueSchemas,
} from './runState';
import { TodoItemSchema } from './todo';
import { TranscriptEventSchemas } from './traceEvent';

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
  'app-state',
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
 * incarnation of its parent. Any other spelling of the edge is
 * `parent !== null`, computed from the fold or the handle.
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
 * The durable arms every renderer folds. This is the one declaration of the
 * run vocabulary: the trace's `AgentEvent` (`src/agent/trace/events.ts`) is
 * derived from these arms, minus the aggregate qualification. Session-scoped
 * arms carry the session facts with the payload flattened. `run.removed` is
 * the tombstone: the last row of its aggregate, final (PRD 5.2, "Existence").
 */
const DisplaySessionEventDraftSchema = z.discriminatedUnion('type', [
  RunStartDraftSchema,
  /**
   * Every activation of a run, the first launch and each resume (PRD 6,
   * item 8); the CLI projection writes it verbatim as a `run.activate`
   * progress record. `run.start` is the creation fact and happens once.
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
  /**
   * The terminal fact (one run model, section 3.3): outcome, the classified
   * error behind a failure, the usage totals, and what the run produced.
   * Written once, by the storage finalizer, after the run's last transcript
   * row; the fold derives the terminal phase from it and from nothing else.
   */
  durable('run.end', RunEndSchema.shape),
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
  RunRemovedDraftSchema,
  /** The AI-generated summary of what the run set out to do. */
  durable('run.description', { description: z.string() }),
  /** Goal is per run, and this row is the goal: it carries the whole
   *  pursuit, so the fold's `RunView.goal` is what every reader reads and
   *  no store holds a second copy. A listing key (`listingTypeOf`'s
   *  default), so a cold read hydrates each run's goal without replaying
   *  the run. */
  durable('goalStateChanged', { state: GoalStateSchema }),
  /** Aggregate is the thread id; `parentRunId` is the payload's edge. */
  durable(
    'inquiryThreadUpdated',
    InquiryThreadUpdatedEventSchema.shape,
    'inquiry',
  ),
  durable('updateQueuedFollowUps', { messages: z.array(z.string()) }),
  /**
   * A run asking a person (one run model, section 3.7): what the UI shows
   * (diff, command, question), never host handles. `thread` names an earlier
   * request this one continues, which is the whole of the inquiry's
   * multi-turn: an inquiry is a request whose thread names its predecessor.
   * Pending is the fold, opened without decided.
   */
  durable('request.opened', {
    requestId: z.string().min(1),
    payload: PermissionPayloadSchema,
    thread: z.string().min(1).nullish(),
  }),
  /**
   * The answer, whatever surface gave it and whatever its provenance. The
   * decision is the durable recovery fact (R5): a `model-retry` or
   * `tool-outcome` binding reads its consent off this row, never off a
   * snapshot alone, and an automatic close names its cause here.
   */
  durable('request.decided', {
    requestId: z.string().min(1),
    decision: RequestDecisionSchema,
  }),
  durable('approval.policy', { snapshot: ApprovalPolicySnapshotSchema }),
  /**
   * The loop's position: family, step, and the coordinates it carries. The
   * one run-ledger row renderers read: the fold derives the live phase from
   * it (`waiting` parks the run, any other step is running) and `RunView.flow`
   * carries its coordinates; its five siblings below are ledger-private.
   */
  durable('flow.step', { payload: FlowStepPayloadSchema }),
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
  durable('run.report', { report: z.string().nullable() }),
  durable('run.result', { result: ResultMetaSchema }),
  durable('run.workspaceFiles', { paths: RunWorkspaceFilesSchema }),
]);
/**
 * The run ledger's private rows (`2026-09-08-pr1-run-ledger-foundation.md`):
 * the byte-exact conversation and the loop's durable state, on the run's
 * aggregate beside its display rows, read only by `foldRunState` through
 * `RunLedger`. Never redacted, never on a renderer's transport
 * (`isDisplaySessionEvent`), never in the cold listing (`listingTypeOf`).
 */
const RunLedgerEventDraftSchema = z.discriminatedUnion('type', [
  durable('model.message', { payload: ModelMessagePayloadSchema }),
  durable('model.compaction', { payload: ModelCompactionPayloadSchema }),
  durable('tool.intent', { payload: ToolIntentPayloadSchema }),
  durable('tool.result', { payload: ToolResultPayloadSchema }),
  durable('flow.snapshot', { payload: FlowSnapshotPayloadSchema }),
  /**
   * One child turn's identity and fate: the child loop's own bookkeeping,
   * never a renderer's. The key is structural, (run, attempt, turn index),
   * so the same accepted turn always folds to the same identity and a
   * later attempt that reuses the run id never collides with it. Pending
   * is the fold: `accepted` without `settled` is the active turn; the
   * latest `settled` is the last turn whose delivery ran.
   */
  durable('child.turn', {
    attemptId: z.string().min(1),
    turnIndex: z.int().positive(),
    phase: z.enum(['accepted', 'settled']),
  }),
]);
/** A stored value as the journal and the state store keep it: `undefined` is
 *  not JSON, so absence is an arm rather than a missing field. */
const PersistedJsonValueSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('undefined') }),
  z.strictObject({ kind: z.literal('json'), value: JsonValueSchema }),
]);
export type PersistedJsonValue = z.infer<typeof PersistedJsonValueSchema>;
/**
 * A workflow script's durable journal (runtime on Effect, section 5, PR 4):
 * one row per completed `agent()` call on the checkpoint aggregate a
 * `run.start.checkpointId` names. The journal folds latest per `key`, so a
 * repeated key replaces its entry and the aggregate only ever appends; the
 * script row is the source the journal replays against, adopted anew on
 * every invocation because a retrying model rarely reproduces it byte for
 * byte.
 */
const WorkflowCheckpointDraftSchema = z.discriminatedUnion('type', [
  durable(
    'workflow.script',
    {
      /** The run the checkpoint hangs under: the run that invoked the
       *  workflow, whose id its checkpoint id is derived from. The database
       *  makes it the aggregate's parent, so removing that run collects the
       *  journal with it instead of stranding these rows. */
      parentRunId: RunIdSchema,
      script: z.string().min(1),
      args: PersistedJsonValueSchema,
      files: WorkflowScriptFilesSchema,
    },
    'workflow-checkpoint',
  ),
  durable(
    'workflow.journal',
    {
      key: z.string().regex(/^[a-f0-9]{16}$/),
      index: z.int().nonnegative(),
      result: PersistedJsonValueSchema,
    },
    'workflow-checkpoint',
  ),
  /**
   * The attempt high-water mark for one `agent()` call: the number of the
   * physical attempt the parent is about to launch, committed before the
   * launch. The child aggregates cannot carry it — deleting a run collects
   * its rows outright, and an id-by-id probe reads that hole as "never
   * launched" and relaunches into it — so the parent's own journal, which
   * outlives every child, keeps the count. Folded as the highest per `key`.
   *
   * `supersededRunId` is the one authorization that closes a child which
   * already started work: a user retrying that child through the workflow's
   * control surface. The engine writes this row for the next attempt before
   * it asks for the replacement, naming the child the retry superseded, so
   * the recovery probe advances past an attempt it would otherwise refuse to
   * repeat. Absent on every mark a launch writes for itself, which is what
   * keeps restart recovery fail-closed for a child nobody retried.
   */
  durable(
    'workflow.attempt',
    {
      key: z.string().regex(/^[a-f0-9]{16}$/),
      attempt: z.int().nonnegative(),
      supersededRunId: RunIdSchema.nullish(),
    },
    'workflow-checkpoint',
  ),
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
/**
 * One host or application state key's latest value: the row behind every
 * `StateStore`, one aggregate per key so latest-per-key is latest-per-
 * aggregate. `{ kind: 'undefined' }` is the delete, the `vscode.Memento`
 * contract every host's store mirrors.
 */
const AppStateDraftSchema = durable(
  'state.value.set',
  { value: PersistedJsonValueSchema },
  'app-state',
);
export const SessionEventDraftSchema = z.discriminatedUnion('type', [
  ...DisplaySessionEventDraftSchema.options,
  ...RunRecordEventDraftSchema.options,
  ...RunLedgerEventDraftSchema.options,
  ...WorkflowCheckpointDraftSchema.options,
  DesktopProjectsDraftSchema,
  GlobalInquiryDraftSchema,
  UpdateCheckDraftSchema,
  AppStateDraftSchema,
]);
export const DisplaySessionEventSchema = z.discriminatedUnion('type', [
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
export type DisplaySessionEvent = z.infer<typeof DisplaySessionEventSchema>;
export const SessionEventSchema = z.discriminatedUnion('type', [
  ...DisplaySessionEventSchema.options,
  ...RunRecordEventDraftSchema.options.map((schema) => schema.extend(envelope)),
  ...RunLedgerEventDraftSchema.options.map((schema) => schema.extend(envelope)),
  ...WorkflowCheckpointDraftSchema.options.map((schema) =>
    schema.extend(envelope),
  ),
  DesktopProjectsDraftSchema.extend(envelope),
  GlobalInquiryDraftSchema.extend(envelope),
  UpdateCheckDraftSchema.extend(envelope),
  AppStateDraftSchema.extend(envelope),
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
 * but the transcript tier. The request pair shares one entry because it
 * folds to one set, and the lifecycle pair (`run.start`, `run.removed`)
 * shares one because it folds to one existence: a tombstone's commit then
 * outranks a replayed `run.start` below it, which is what makes the
 * tombstone final under every read (5.2, "Existence"). `flow.step` is a
 * listing key of its own: the phase is folded from it, so a cold listing
 * that dropped it would paint every parked run as ready. `stage.start` is
 * transcript tier alone: its display arm is a no-op and only the transcript
 * fold reads it over the whole aggregate, so listing it would pull the latest
 * one of every run into every renderer for no reader.
 */
export function listingTypeOf(
  event: Pick<SessionEvent, 'type'>,
): string | null {
  switch (event.type) {
    case 'log':
    case 'stage.start':
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
    case 'model.message':
    case 'model.compaction':
    case 'tool.intent':
    case 'tool.result':
    case 'flow.snapshot':
    case 'child.turn':
    case 'workflow.script':
    case 'workflow.journal':
    case 'workflow.attempt':
      // The run ledger's private rows stay out of the listing: a cold hydrate
      // must never pull a run's latest `flow.snapshot` into every renderer.
      // `flow.step` is the one ledger row that is listed (its own key, the
      // `default` below). The keyed private records and the checkpoint
      // journal are folded by their readers over the whole aggregate, so
      // "latest of type" is not a fact about them. Not compiler-enforced
      // (the switch ends in `default`); the fold suite pins it.
      return null;
    case 'request.opened':
    case 'request.decided':
      return 'request';
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
