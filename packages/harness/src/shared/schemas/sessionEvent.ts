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
 * Layering: this module lives under `packages/harness/src/shared/schemas` so the fold and the
 * transport stay free of `@agent/*` (`dependencyDirection.vitest.ts` keeps the
 * shared-to-agent allowlist empty).
 */
import { Result } from 'effect';
import { z } from 'zod';

import { parseJsonWith } from '@common/parsing/safeParseJson';

import { APPROVAL_BYPASS_KINDS } from '@shared/approvalBypassKind';
import { JsonValueSchema } from './jsonValue';
import {
  RunEndRowSchema,
  RunRecordFieldsSchema,
  ResultMetaSchema,
} from './runRecords';
import { RunIdSchema, type RunId } from './identifiers';
import { FollowUpContentSchema } from './followUp';
import { PermissionPayloadSchema } from './progressView/data';
import { RunFactSchema } from './rowValues';
import { RequestDecisionSchema } from './request';
import { RunIdentitySchema } from './runIdentity';
import { RunBindingSchema } from './runFacts';
import {
  RunPositionPayloadSchema,
  ContextEditPayloadSchema,
  ModelMessagePayloadSchema,
  ToolBindingPayloadSchema,
  ScriptCallPayloadSchema,
  ToolIntentPayloadSchema,
  ToolResultPayloadSchema,
} from './runHistoryEvent';
import { ContextBlobSchema, ToolsOfferedPayloadSchema } from './offeredTools';
import { HookOutcomePayloadSchema } from './hookOutcome';
import { UserFollowUpSupportSchema, WorktreeInfoSchema } from './run';
import { ConversationProgressSchema } from './runState';
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
 *  `run` is keyed by the run id, `plugin` (one a plugin owns) `<plugin>:<key>`. */
const AggregateKindSchema = z.enum(['run', 'plugin']);
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

/**
 * A run's approval grants after a change, the one record of them: what the
 * run itself decided, never what it inherits. A kind the run decides
 * nothing about defers to its parent's grants while the edge stands, which
 * is read off the rows (`resolveBypass`), never stored here.
 */
export const ApprovalPolicySnapshotSchema = z.object({
  /** The run's own human value per kind, where it has one: `on` granted,
   *  `off` an explicit override. */
  own: z.partialRecord(z.enum(APPROVAL_BYPASS_KINDS), z.enum(['on', 'off'])),
  /** The kinds the run's autonomous goal grants it, over its own values
   *  until the goal ends or a human decides that kind. A resume ends them:
   *  its activation writes them off until a human re-arms the goal. */
  goal: z.array(z.enum(APPROVAL_BYPASS_KINDS)).readonly(),
});

/**
 * The envelope every durable arm rides (contract C1). A run-scoped fact's
 * aggregate is its run; a plugin's own aggregate is the plugin's key
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
 * inside the child's creation transaction so a logical id a retry reuses
 * can never redirect the child to a later incarnation of its parent. Any other spelling of the edge is `parent !== null`, computed from
 * the fold or the handle.
 */
const RunParentSchema = z.object({
  id: RunIdSchema,
  uid: z.uuid(),
  /** The parent's tool call that launched this run (an `agent` call's
   *  child, a background `script` run), which owns it until it detaches;
   *  null for a child no call launched. */
  callId: z.string().min(1).nullable(),
});
export type RunParent = z.infer<typeof RunParentSchema>;

/**
 * Where a run's history came from, when not from its own launch: a fork
 * copies the model view of run `from` at its settled `seq` `at`. Resume is
 * not a provenance; it is the same run. (Not `origin`: the envelope's
 * `origin` is the process that wrote the row.)
 */
const RunProvenanceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('fork'),
    from: RunParentSchema.pick({ id: true, uid: true }),
    at: z.int().positive(),
  }),
]);
export type RunProvenance = z.infer<typeof RunProvenanceSchema>;

/**
 * Per-run launch facts. Existence fact: a run exists iff its `run.start`
 * exists, once per incarnation, seq 1 of its aggregate (decision 9); the
 * aggregate's logical id is the run id, so the row carries no second copy of
 * it. `worktree` is absent for a run that executes in the workspace itself
 * rather than in a dedicated worktree. `category`
 * and `userFollowUpSupport` are explicit on every run: the
 * launcher knows them for an agent, a process, and a script alike,
 * and the fold reads them verbatim and derives nothing (PRD 6, item 6). The
 * initial approval-policy snapshot rides here rather than as its own event
 * (PRD 6, item 2): under the latest-of-type rule a run never edited would
 * otherwise have no policy entry, and on the payload it is atomic with the
 * run's existence.
 */
const RunStartEventSchema = durable('run.start', {
  identity: RunIdentitySchema,
  userFollowUpSupport: UserFollowUpSupportSchema,
  worktree: WorktreeInfoSchema.nullish(),
  /** The launching run with its creation coordinate; null for a root. */
  parent: RunParentSchema.nullable(),
  /** Null for a run that starts fresh. */
  provenance: RunProvenanceSchema.nullable(),
  /** The parent's tool card (its `logId`) whose call launched this run: an
   *  `agent` call's child, a `script` call's background run. Absent for a
   *  root and for a child no card launched. */
  parentCard: z.string().min(1).nullish(),
  /** The run's approval policy at launch, from the session's single authority. */
  approvalPolicy: ApprovalPolicySnapshotSchema.nullish(),
});

/** C9 cleanup targets: the run directories owned by this lifecycle, derived by the database. */
const RunRemovedEventSchema = durable('run.removed', {
  runIds: z.array(RunIdSchema),
});

/** A launcher names the parent; the database stamps its creation commit. */
const RunStartDraftSchema = RunStartEventSchema.omit({ parent: true }).extend({
  parent: RunParentSchema.omit({ uid: true }).nullable(),
});
const RunRemovedDraftSchema = RunRemovedEventSchema.omit({
  runIds: true,
});

/** A row of a plugin's own kind (`@tools/pluginArms`): core folds `value`
 *  latest per (plugin, kind) and never reads it; the plugin decodes it. A
 *  run's is `RunView.facts`; a plugin aggregate's is `SessionView.pluginFacts`,
 *  under its `parent` run (whose deletion collects it) or none. */
export const PluginFactDraftSchema = durable('plugin.fact', {
  plugin: z.string().min(1),
  kind: z.string().min(1),
  /** The arm's version `value` was written at: a plugin evolves its
   *  kinds without a core row version. */
  version: z.int().positive(),
  value: JsonValueSchema,
  parent: RunIdSchema.nullable(),
}).extend({ aggregateId: AggregateIdSchema });

/**
 * The durable arms every renderer folds. This is the one declaration of the
 * run vocabulary: the trace's `AgentEvent` (`packages/harness/src/agent/trace/events.ts`) is
 * derived from these arms, minus the aggregate qualification. Session-scoped
 * arms carry the session facts with the payload flattened. `run.removed` is
 * the tombstone: the last row of its aggregate, final (PRD 5.2, "Existence").
 */
const DisplaySessionEventDraftSchema = z.discriminatedUnion('type', [
  RunStartDraftSchema,
  /** Every activation of a run, the first launch and each resume (PRD 6,
   *  item 8); `run.start` is the creation fact and happens once. */
  durable('run.activate', {}),
  /** What the run runs with, written at registration and then only when it
   *  changes: the newest row is the configuration every reader reads, its
   *  model the one the run is on (a switch writes a new row). `binding`
   *  joins once the run's loop binds its model. */
  durable('run.config', {
    config: RunRecordFieldsSchema,
    binding: RunBindingSchema.nullish(),
  }),
  durable('run.model', { model: z.string().min(1) }), // projected (`projections.ts`), never stored
  /** The parent edge severed by a stop that detaches the run: the only
   *  fact after `run.start` that moves the edge. */
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
  durable('run.fact', { fact: RunFactSchema }),
  /**
   * A child driven by the child loop, which has no run history or rounds, parks
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
  /** A run's title, and who gave it: the model's summary, or the user's
   *  rename, which a later model title does not replace. */
  durable('run.description', {
    description: z.string(),
    by: z.enum(['model', 'user']),
  }),
  PluginFactDraftSchema,
  /** Input a run has not taken yet (one run model, section 3.7), whole, so
   *  a crash loses nothing; `followUpId` is the producer's delivery id or
   *  minted. Pending is queued without consumed. */
  durable('followup.queued', {
    followUpId: z.string().min(1),
    content: FollowUpContentSchema,
    /** Held until a take also carries an instruction (a pause notice). */
    holdUntil: z.enum(['instruction']).optional(),
    /** A request of the run's own, consumed by the batch that applies it. */
    control: z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('compact') }),
        z.object({ kind: z.literal('model'), model: z.string().min(1) }),
      ])
      .optional(),
  }),
  /** The follow-up became the message a turn carries (C3), in that
   *  message's batch: never delivered twice. */
  durable('followup.consumed', { followUpId: z.string().min(1) }),
  /**
   * A run asking a person (one run model, section 3.7): what the UI shows,
   * never host handles. `thread` names an earlier request this one
   * continues (an inquiry's multi-turn). Pending is opened without decided.
   */
  durable('request.opened', {
    requestId: z.string().min(1),
    payload: PermissionPayloadSchema,
    thread: z.string().min(1).nullish(),
  }),
  /**
   * The answer, whatever surface gave it and whatever its provenance. The
   * decision is the durable recovery fact (R5): a model retry (the `failed`
   * row that asks) reads its consent off this row, never off a snapshot
   * alone, and an automatic close names its cause here.
   */
  durable('request.decided', {
    requestId: z.string().min(1),
    decision: RequestDecisionSchema,
  }),
  durable('approval.policy', { snapshot: ApprovalPolicySnapshotSchema }),
  /**
   * The loop's position: family, `at`, and coordinates. The one run-history
   * row renderers read: the fold derives the live phase from it (`waiting`
   * parks the run, any other position is running) and `RunView.position`
   * carries its coordinates; its five siblings below are run-history-private.
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
 * The run history's private rows: the byte-exact conversation and the loop's durable state (its hooks'
 * outcomes included), read only by `foldRunState` through `RunHistory`. Never
 * redacted, on a renderer's transport or in the cold listing.
 */
const RunHistoryEventDraftSchema = z.discriminatedUnion('type', [
  durable('model.message', { payload: ModelMessagePayloadSchema }),
  durable('context.edit', { payload: ContextEditPayloadSchema }),
  durable('tool.intent', { payload: ToolIntentPayloadSchema }),
  /** A call a script issued, with its arguments: committed with its intent. */
  durable('script.call', { payload: ScriptCallPayloadSchema }),
  /** Binds a call attempt to its own request; commits with the request. */
  durable('tool.binding', { payload: ToolBindingPayloadSchema }),
  durable('tool.result', { payload: ToolResultPayloadSchema }),
  durable('tools.offered', { payload: ToolsOfferedPayloadSchema }),
  durable('context.blob', { payload: ContextBlobSchema }),
  durable('hook.outcome', { payload: HookOutcomePayloadSchema }),
  /**
   * One child turn's identity and fate, the child loop's own bookkeeping.
   * The key is structural, (run, attempt, turn index), so an accepted turn
   * always folds to one identity and a later attempt reusing the run id
   * never collides with it. `accepted` without `settled` is the active
   * turn; the latest `settled` is the last turn whose delivery ran. Its
   * `delivery` names the parent and follow-up id of the `run.report` just
   * before it in its batch: the parent's row is that report's relay.
   */
  durable('child.turn', {
    attemptId: z.string().min(1),
    turnIndex: z.int().positive(),
    phase: z.enum(['accepted', 'settled']),
    delivery: z
      .object({ to: RunIdSchema, followUpId: z.string().min(1) })
      .optional(),
  }),
]);
export const SessionEventDraftSchema = z.discriminatedUnion('type', [
  ...DisplaySessionEventDraftSchema.options,
  ...RunRecordEventDraftSchema.options,
  ...RunHistoryEventDraftSchema.options,
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
  ...RunHistoryEventDraftSchema.options.map((schema) =>
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
  if (event.type === 'run.start' && event.parent !== null)
    ids.push(aggregateId('run', event.parent.id));
  if (event.type === 'plugin.fact' && event.parent !== null)
    ids.push(aggregateId('run', event.parent));
  return ids;
}

/**
 * The aggregate-graph edges one draft declares, applied by the store in the
 * transaction that appends it: the parent a `run.start` stamps, the
 * aggregate a row hangs its target under (a plugin's aggregate under its
 * `parent` run, or none), the claim a plugin's aggregate borrows for that
 * transaction alone, and the closure a tombstone makes.
 * {@link referencedAggregates} reads the same edges off committed rows.
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
    case 'plugin.fact':
      return aggregateTarget(draft.aggregateId).kind === 'run'
        ? { parent: null, borrowsClaim: false, closes: false }
        : {
            parent: null,
            reparent:
              draft.parent === null ? null : aggregateId('run', draft.parent),
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
    case 'stream.start':
    case 'stream.end':
    case 'response.finalized':
    case 'usage':
    case 'model.message':
    case 'context.edit':
    case 'tool.intent':
    case 'script.call':
    case 'tool.binding':
    case 'tool.result':
    case 'tools.offered':
    case 'context.blob':
    case 'hook.outcome':
    case 'child.turn':
      // A priced turn is never "latest of type" (`listingKeyOf`). Run-history
      // rows stay out: a cold hydrate never pulls one into every
      // renderer (`run.position` is a listing row). Keyed
      // records fold whole; the fold suite pins this list.
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
  // Both a run's latest model title and its latest user title are kept:
  // the fold lets the user's win.
  if (event.type === 'run.description') return `${type}/${event.by}`;
  return event.type === 'run.fact' ? `${type}/${event.fact.key}` : type;
}

/**
 * The open sets the listing keeps beside its latest rows: an open request
 * and a queued follow-up are keys of their own, closed by their pair.
 */
export function pendingKeyOf(
  event: SessionEvent,
): { readonly key: string; readonly open: boolean } | null {
  const open =
    event.type === 'request.opened' || event.type === 'followup.queued';
  switch (event.type) {
    case 'request.opened':
    case 'request.decided':
      return { key: `request/${event.requestId}`, open };
    case 'followup.queued':
    case 'followup.consumed':
      return { key: `followup/${event.followUpId}`, open };
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
