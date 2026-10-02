/**
 * The fold's durable input vocabulary (.agents/docs/implemented/architecture/2026-09-03-prd-one-fold-three-renderers.md
 * sections 5.2 and 6): the session events every process folds into
 * `SessionView`. The transient arms that never carry a seq are
 * `foldInput.ts`.
 *
 * Every durable arm rides one envelope: the aggregate it belongs to, its
 * per-aggregate `seq`, the store-local `commit` cursor, the writing `origin`
 * and the publish clock; its durable identity is its aggregate's `uid` and
 * its `seq`. The arms mirror the trace (`AgentEvent`) shapes field for field
 * where the fold reads them, so a publisher translates by naming fields.
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

import { APPROVAL_BYPASS_KINDS } from '@shared/approvalBypassKind';
import { TexraApprovalPolicySchema } from '@shared/approvalPolicy';
import { AgentCategorySchema } from './agent';
import { RoundOutputSchema } from './output';
import { JsonValueSchema } from './jsonValue';
import {
  RunEndRowSchema,
  RunRecordFieldsSchema,
  ResultMetaSchema,
} from './runRecords';
import { RunIdSchema, type RunId } from './identifiers';
import { FollowUpContentSchema } from './followUp';
import { WorkflowScriptFilesSchema } from './workflowScriptFiles';
import { InquiryThreadSummarySchema } from './inquiry';
import { PermissionPayloadSchema } from './progressView/data';
import { PersistedJsonValueSchema, RunFactSchema } from './rowValues';
import { RequestDecisionSchema } from './request';
import { RunIdentitySchema } from './runIdentity';
import {
  RunSnapshotPayloadSchema,
  RunPositionPayloadSchema,
  ModelCompactionPayloadSchema,
  ModelMessagePayloadSchema,
  ModelRetryPayloadSchema,
  ToolBindingPayloadSchema,
  ScriptCallPayloadSchema,
  ToolIntentPayloadSchema,
  ToolResultPayloadSchema,
} from './runLedgerEvent';
import { ContextBlobSchema, ToolsOfferedPayloadSchema } from './offeredTools';
import { HookOutcomePayloadSchema } from './hookOutcome';
import { UserFollowUpSupportSchema, WorktreeInfoSchema } from './run';
import { ApprovalBypassesSchema, ConversationProgressSchema } from './runState';
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
 * A verdict about an owner is a proof or an admission that no proof exists.
 * `unprovable` means "do not touch automatically": every acquire path treats
 * it exactly like `alive`, and the user sees the aggregate as held. The
 * user's explicit deletion of the run is the one path that reaps it.
 */
export type OwnerLiveness = 'alive' | 'dead' | 'unprovable';

/** C2 separates independent lifecycles even when their logical ids coincide:
 *  `run` is keyed by the run id, every other kind by its own logical id. */
const AggregateKindSchema = z.enum(['run', 'workflow-checkpoint', 'inquiry']);
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
 *  first commit", the cursor an empty view starts from. Local: no row
 *  stores one. */
export const CommitOrdinalSchema = z.int().nonnegative();
export type CommitOrdinal = z.infer<typeof CommitOrdinalSchema>;

/** The full approval-policy snapshot after a change, from the single policy
 *  authority (`src/shared/approvalPolicy.ts`); the fold keeps the latest. */
export const ApprovalPolicySnapshotSchema = z.object({
  policy: TexraApprovalPolicySchema,
  /** Each kind's effective value, own or inherited: what surfaces show. */
  bypasses: ApprovalBypassesSchema,
  /**
   * The run's own human value per kind, where it has one (absent: it defers
   * to its ancestry): `on` granted, `off` an explicit override. A resume in
   * a new process restores exactly these.
   */
  own: z.partialRecord(z.enum(APPROVAL_BYPASS_KINDS), z.enum(['on', 'off'])),
  /** The kinds the run's autonomous goal grants it, over its own values
   *  until the goal ends or a human decides that kind. Never restored: a
   *  resume leaves them off until a human re-arms the goal. */
  goal: z.array(z.enum(APPROVAL_BYPASS_KINDS)),
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
  /** The process that appended the row (not the aggregate's claim holder);
   *  null for the trace viewer's reconstruction, which has no writer. */
  origin: OwnerIdSchema.nullable(),
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
 * launching run; `uid` is that run's incarnation, stamped by the database
 * inside the child's creation transaction so a logical id a workflow-script
 * retry reuses can never redirect the child to a later incarnation of its
 * parent. Any other spelling of the edge is `parent !== null`, computed from
 * the fold or the handle.
 */
const RunParentSchema = z.object({
  id: RunIdSchema,
  uid: z.uuid(),
});
export type RunParent = z.infer<typeof RunParentSchema>;

/**
 * Per-run launch facts. Existence fact: a run exists iff its `run.start`
 * exists, once per incarnation, seq 1 of its aggregate (decision 9); the
 * aggregate's logical id is the run id, so the row carries no second copy of
 * it. `worktree` is absent for a run that executes in the workspace itself
 * rather than in a dedicated worktree. `category`
 * and `userFollowUpSupport` are explicit on every run: the
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
  worktree: WorktreeInfoSchema.nullish(),
  /** The launching run with its creation coordinate; null for a root. */
  parent: RunParentSchema.nullable(),
  /** The parent's tool card (its `logId`) whose call launched this run: an
   *  `agent` call's child, a `script` call's background run. Absent for a
   *  root and for a child no card launched. */
  parentCard: z.string().min(1).nullish(),
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
  durable('run.activate', { category: AgentCategorySchema }),
  /** What the run runs with, written at registration and then only when it
   *  changes: the newest row is the configuration every reader reads. */
  durable('run.config', { config: RunRecordFieldsSchema }),
  durable('run.model', { model: z.string().min(1) }), // projected (`projections.ts`), never stored
  /**
   * The parent edge severed: a child promoted to the top level by a stop
   * that detaches its children. The only fact after `run.start` that moves
   * the edge; a run never acquires a new parent.
   */
  durable('run.detach', {}),
  /**
   * The terminal fact (one run model, section 3.3): outcome, the classified
   * error behind a failure, and a tool-use run's reply (usage and workflow
   * files have their own rows). Written once per lifecycle, by the storage
   * finalizer, after the run's last transcript row; the fold derives the
   * terminal phase from it and from nothing else.
   */
  durable('run.end', RunEndRowSchema.shape),
  durable('conversation.progress', { progress: ConversationProgressSchema }),
  durable('output.produced', { rounds: z.array(RoundOutputSchema) }),
  durable('run.fact', { fact: RunFactSchema }),
  /**
   * A child driven by the child loop, which has no ledger or rounds, parks
   * on its own row (one run model, 3.3): `parked` before the loop blocks on
   * its queue, `resumed` when a batch starts the next turn (what
   * `getToolUseFollowUpTarget` reads to admit a turn), `paused` when a stop
   * rests it with no `run.end`, keeping the `resumeId` a tool call continues
   * it by. A listing key of its own (`listingTypeOf`'s default): a cold
   * listing that dropped it would paint every parked child as busy.
   */
  durable('child.park', {
    phase: z.enum(['parked', 'resumed', 'paused']),
    resumeId: z.string().optional(),
  }),
  RunRemovedDraftSchema,
  /** The AI-generated summary of what the run set out to do. */
  durable('run.description', { description: z.string() }),
  /** A row of a plugin's own kind (`@tools/pluginArms`): core folds `value`
   *  latest per (plugin, kind) and never reads it; the plugin decodes it. */
  durable('plugin.fact', {
    plugin: z.string().min(1),
    kind: z.string().min(1),
    /** The arm's version `value` was written at: a plugin evolves its
     *  kinds without a core row version. */
    version: z.int().positive(),
    value: JsonValueSchema,
  }),
  /** Aggregate is the thread id; `parentRunId` is the payload's edge. */
  durable('inquiryThreadUpdated', InquiryThreadSummarySchema.shape, 'inquiry'),
  /**
   * Input a run has not taken yet (one run model, section 3.7): the whole
   * follow-up, so a resume seeds the run's queue from its rows and a crash
   * loses nothing. `followUpId` is the unique key: the producer's logical
   * delivery id when it has one (a child's accepted turn, an inquiry
   * continuation), otherwise minted once at admission. Pending is the fold,
   * queued without consumed, and it is the view's `queuedFollowUps`.
   */
  durable('followup.queued', {
    followUpId: z.string().min(1),
    content: FollowUpContentSchema,
    /** Held until the sender's terminal row (#8093) or an instruction. */
    holdUntil: z.enum(['senderEnd', 'instruction']).optional(),
  }),
  /**
   * The follow-up became the message a turn carries (C3): committed in the
   * same batch as that message, so a crash between the two re-delivers the
   * follow-up and never delivers it twice.
   */
  durable('followup.consumed', { followUpId: z.string().min(1) }),
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
   * The loop's position: family, `at`, and coordinates. The one run-ledger
   * row renderers read: the fold derives the live phase from it (`waiting`
   * parks the run, any other position is running) and `RunView.position`
   * carries its coordinates; its five siblings below are ledger-private.
   */
  durable('run.position', { payload: RunPositionPayloadSchema }),
  ...Object.values(TranscriptEventSchemas).map((schema) =>
    schema.extend({
      aggregateId: AggregateIdSchema.refine(
        (key) => aggregateTarget(key).kind === 'run',
        `Expected a run aggregate for ${schema.shape.type.value}`,
      ),
    }),
  ),
]);
/** The run's private records, read by the runtime and never by a renderer
 *  (`isDisplaySessionEvent`). `followup.closed`: its input is closed until a
 *  claim reopens it or it activates again. */
const RunRecordEventDraftSchema = z.discriminatedUnion('type', [
  durable('run.report', { report: z.string().nullable() }),
  durable('run.result', { result: ResultMetaSchema }),
  durable('followup.closed', {}),
]);
/**
 * The run ledger's private rows (`2026-09-08-pr1-run-ledger-foundation.md`):
 * the byte-exact conversation and the loop's durable state (its hooks'
 * outcomes included), read only by `foldRunState` through `RunLedger`. Never
 * redacted, on a renderer's transport or in the cold listing.
 */
const RunLedgerEventDraftSchema = z.discriminatedUnion('type', [
  durable('model.message', { payload: ModelMessagePayloadSchema }),
  durable('model.compaction', { payload: ModelCompactionPayloadSchema }),
  durable('tool.intent', { payload: ToolIntentPayloadSchema }),
  /** A call a script issued, with its arguments: committed with its intent. */
  durable('script.call', { payload: ScriptCallPayloadSchema }),
  /** Guards one outcome-unknown call; commits with the request it names. */
  durable('tool.binding', { payload: ToolBindingPayloadSchema }),
  durable('tool.result', { payload: ToolResultPayloadSchema }),
  /** The human retry permit, written by the one retry owner
   *  (`ModelInvoker`): the gate a restart reads back. */
  durable('model.retry', { payload: ModelRetryPayloadSchema }),
  durable('run.snapshot', { payload: RunSnapshotPayloadSchema }),
  durable('tools.offered', { payload: ToolsOfferedPayloadSchema }),
  durable('context.blob', { payload: ContextBlobSchema }),
  durable('hook.outcome', { payload: HookOutcomePayloadSchema }),
  /**
   * One child turn's identity and fate, the child loop's own bookkeeping.
   * The key is structural, (run, attempt, turn index), so an accepted turn
   * always folds to one identity and a later attempt reusing the run id
   * never collides with it. `accepted` without `settled` is the active
   * turn; the latest `settled` is the last turn whose delivery ran.
   */
  durable('child.turn', {
    attemptId: z.string().min(1),
    turnIndex: z.int().positive(),
    phase: z.enum(['accepted', 'settled']),
  }),
]);
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
   * control surface. The engine writes this row at that child's own attempt,
   * naming it, before it asks for the replacement (the mark stays put, so the
   * replacement's id reads as the free slot above it), so
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
export const SessionEventDraftSchema = z.discriminatedUnion('type', [
  ...DisplaySessionEventDraftSchema.options,
  ...RunRecordEventDraftSchema.options,
  ...RunLedgerEventDraftSchema.options,
  ...WorkflowCheckpointDraftSchema.options,
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
]);
export type SessionEvent = z.infer<typeof SessionEventSchema>;

/**
 * What a publisher hands `SessionEvents.publish`: the body plus the aggregate
 * it lives on (contract C2). The publisher stamps the rest of the envelope
 * (`seq`, `commit`, `origin`, `at`) under its permit; no caller passes them.
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
 * The aggregate-graph edges one draft declares, applied by the store in the
 * transaction that appends it: the parent a `run.start` stamps, the
 * aggregate a row hangs its target under (a workflow checkpoint under the
 * run that invoked it; an inquiry thread under its asking run, or none),
 * the claim an inquiry update borrows for that transaction alone, and the
 * closure a tombstone makes. {@link referencedAggregates} reads the same
 * edges off committed rows.
 */
export interface AggregateEdges {
  readonly parent: AggregateId | null;
  /** Absent: the target keeps its parent. */
  readonly reparent?: AggregateId | null;
  readonly borrowsClaim: boolean;
  readonly closes: boolean;
}

export function edgesOf(draft: SessionEventDraft): AggregateEdges {
  switch (draft.type) {
    case 'run.start':
      return {
        parent:
          draft.parent === null ? null : aggregateId('run', draft.parent.id),
        borrowsClaim: false,
        closes: false,
      };
    case 'workflow.script':
      return {
        parent: null,
        reparent: aggregateId('run', draft.parentRunId),
        borrowsClaim: false,
        closes: false,
      };
    case 'inquiryThreadUpdated':
      return {
        parent: null,
        reparent:
          draft.parentRunId === null
            ? null
            : aggregateId('run', draft.parentRunId),
        borrowsClaim: true,
        closes: false,
      };
    case 'run.removed':
      return { parent: null, borrowsClaim: false, closes: true };
    default:
      return { parent: null, borrowsClaim: false, closes: false };
  }
}

/**
 * The listing types the fold keys `latest` by (PRD 5.1): every durable arm
 * but the transcript tier. The request pair shares one entry because it
 * folds to one set, the follow-up pair likewise, and the lifecycle pair (`run.start`, `run.removed`)
 * shares one because it folds to one existence: a tombstone's commit then
 * outranks a replayed `run.start` below it, which is what makes the
 * tombstone final under every read (5.2, "Existence"). `run.position` is a
 * listing key of its own: the phase is folded from it, so a cold listing
 * that dropped it would paint every parked run as ready. `stage.start` is
 * transcript tier alone: its display arm is a no-op and only the transcript
 * fold reads it over the whole aggregate, so listing it would pull the latest
 * one of every run into every renderer for no reader.
 *
 * `run.fact` and `plugin.fact` hold several families on one type, so they
 * are read grouped by family as well (`listingKeyOf`, `Database`).
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
    case 'stream.start':
    case 'stream.end':
    case 'response.finalized':
    case 'usage':
    case 'model.message':
    case 'model.compaction':
    case 'tool.intent':
    case 'script.call':
    case 'tool.binding':
    case 'tool.result':
    case 'model.retry':
    case 'run.snapshot':
    case 'tools.offered':
    case 'context.blob':
    case 'hook.outcome':
    case 'child.turn':
    case 'workflow.script':
    case 'workflow.journal':
    case 'workflow.attempt':
      // A priced turn is never "latest of type" (`listingKeyOf`). Run-ledger
      // rows stay out: a cold hydrate never pulls a `run.snapshot` into every
      // renderer (`run.position`, `output.produced` are listing rows). Keyed
      // records and the journal fold whole; the fold suite pins this list.
      return null;
    case 'request.opened':
    case 'request.decided':
      return 'request';
    case 'followup.queued':
    case 'followup.consumed':
      return 'followup';
    case 'run.start':
    case 'run.removed':
      return 'lifecycle';
    default:
      return event.type;
  }
}

/**
 * The `latest` key one row folds under: its listing type, qualified by the
 * row's own discriminator where it carries one. The mirror of the listing
 * query's `GROUP BY`, so "the newest row the fold holds" means the same
 * thing on a cold read and on a replay: one `run.fact` family's newest row
 * never suppresses another's.
 */
export function listingKeyOf(event: SessionEvent): string | null {
  // A run's spend: the listing returns its total at its newest priced row,
  // so one key per run orders every read's turns by commit.
  if (event.type === 'usage') return 'usage';
  const type = listingTypeOf(event);
  if (type === null) return null;
  if (event.type === 'plugin.fact')
    return `${type}/${event.plugin}/${event.kind}`;
  return event.type === 'run.fact' ? `${type}/${event.fact.key}` : type;
}

/**
 * The open sets the listing keeps beside its latest rows: an open request
 * and a queued follow-up are keys of their own, closed by their pair. The
 * fold and the listing projection both key them here.
 */
export function pendingKeyOf(
  event: SessionEvent,
): { readonly open: string } | { readonly close: string } | null {
  switch (event.type) {
    case 'request.opened':
      return { open: `request/${event.requestId}` };
    case 'request.decided':
      return { close: `request/${event.requestId}` };
    case 'followup.queued':
      return { open: `followup/${event.followUpId}` };
    case 'followup.consumed':
      return { close: `followup/${event.followUpId}` };
    default:
      return null;
  }
}

export const DISPLAY_EVENT_TYPES: readonly string[] = Object.freeze(
  DisplaySessionEventDraftSchema.options.map(
    (schema) => schema.shape.type.value,
  ),
);

/** A run's private records and the profile-state rows never enter display transport. */
export function isDisplaySessionEvent(
  event: SessionEvent,
): event is DisplaySessionEvent {
  return DISPLAY_EVENT_TYPES.includes(event.type);
}
