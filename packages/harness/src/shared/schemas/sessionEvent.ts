/**
 * The durable session events every process applies to its `SessionView`
 * (.agents/docs/implemented/architecture/2026-09-03-prd-one-fold-three-renderers.md
 * sections 5.2 and 6). The other view inputs, which never carry a seq, are
 * in `sessionViewInput.ts`.
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
import { Schema, Struct, Tuple } from 'effect';

import { ApprovalPolicySnapshotSchema } from '@shared/approvalBypassKind';
import {
  AggregateIdSchema,
  OwnerIdSchema,
  aggregateTarget,
  qualifyAggregateId,
  type AggregateId,
  type AggregateKind,
} from './aggregateId';
import { JsonValueSchema } from './jsonValue';
import {
  RunEndRowSchema,
  RunRecordFieldsSchema,
  ResultMetaSchema,
} from './runRecords';
import { RunIdSchema } from './identifiers';
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
  ScriptCallPayloadSchema,
  ToolIntentPayloadSchema,
  ToolResultPayloadSchema,
} from './runHistoryEvent';
import { ContextBlobSchema, ToolsOfferedPayloadSchema } from './offeredTools';
import { HookOutcomePayloadSchema } from './hookOutcome';
import { UserFollowUpSupportSchema, WorktreeInfoSchema } from './run';
import { ConversationProgressSchema } from './runState';
import { TranscriptEventSchema } from './traceEvent';

/** Per-aggregate append order; `run.start` is seq 1 of its run. Dense from
 *  1, assigned by the substrate's publisher and by nothing else. */
const SeqSchema = Schema.Int.check(Schema.isGreaterThan(0));

/** The session-wide insert ordinal a replay follows; zero is "before the
 *  first commit", the cursor an empty view starts from. Local: no row
 *  stores one. */
export const CommitOrdinalSchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
);
export type CommitOrdinal = typeof CommitOrdinalSchema.Type;

/**
 * The envelope every durable arm rides, in the event table's own columns. A
 * run-scoped fact's aggregate is its run; a plugin's own aggregate is the
 * plugin's key (no sentinel run id exists). `at` is the publish clock,
 * informational only; ordering is `seq` within an aggregate and `commit`
 * across them.
 */
const envelope = {
  seq: SeqSchema,
  commit: CommitOrdinalSchema,
  /** The process that appended the row (not the aggregate's claim holder);
   *  null for the trace viewer's reconstruction, which has no writer. */
  origin: Schema.NullOr(OwnerIdSchema),
  /** The publish clock in whole milliseconds: the store keeps it in an
   *  `INTEGER` column of a `STRICT` table, so the vocabulary states that
   *  rule here and the substrate restates it nowhere. */
  at: Schema.Int,
};

/** The aggregate column of a `type` row, checked to be of the given kind. */
function aggregateIdOf(type: string, kind: AggregateKind) {
  return AggregateIdSchema.check(
    Schema.makeFilter((key) => aggregateTarget(key).kind === kind, {
      message: `Expected a ${kind} aggregate for ${type}`,
    }),
  );
}

function durable<T extends string, const F extends Schema.Struct.Fields>(
  type: T,
  fields: F,
  kind: AggregateKind = 'run',
) {
  return Schema.Struct({
    aggregateId: aggregateIdOf(type, kind),
    stageId: Schema.optional(Schema.String),
    type: Schema.Literal(type),
    ...fields,
  });
}

type TranscriptFields = Schema.Struct.Fields & {
  readonly type: Schema.Literal<string>;
};
type RunAggregateField = {
  readonly aggregateId: ReturnType<typeof aggregateIdOf>;
};
/** A transcript arm (`traceEvent.ts`) as a durable row on its run's aggregate. */
interface OnRunAggregate extends Struct.Lambda {
  <F extends TranscriptFields>(
    schema: Schema.Struct<F>,
  ): Schema.Struct<Struct.Assign<F, RunAggregateField>>;
  readonly '~lambda.out': this['~lambda.in'] extends Schema.Struct<
    infer F extends TranscriptFields
  >
    ? Schema.Struct<Struct.Assign<F, RunAggregateField>>
    : never;
}
const onRunAggregate = Struct.lambda<OnRunAggregate>((schema) =>
  schema.mapFields(
    Struct.assign({
      aggregateId: aggregateIdOf(schema.fields.type.literal, 'run'),
    }),
  ),
);

/**
 * The parent edge (one run model, section 3.2): the whole of it. `id` is the
 * launching run; `uid` is that run's incarnation, stamped by the database
 * inside the child's creation transaction so a logical id a retry reuses
 * can never redirect the child to a later incarnation of its parent. Any other spelling of the edge is `parent !== null`, computed from
 * the fold or the handle.
 */
const RunParentSchema = Schema.Struct({
  id: RunIdSchema,
  uid: Schema.String.check(Schema.isUUID()),
  /** The parent's tool call that launched this run (an `agent` call's
   *  child, a background `script` run), which owns it until it detaches;
   *  null for a child no call launched. */
  callId: Schema.NullOr(Schema.String.check(Schema.isMinLength(1))),
});
export type RunParent = typeof RunParentSchema.Type;

/**
 * Where a run's history came from, when not from its own launch: a fork
 * copies the model view of run `from` at its settled `seq` `at`. Resume is
 * not a provenance; it is the same run. (Not `origin`: the envelope's
 * `origin` is the process that wrote the row.)
 */
const RunProvenanceSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('fork'),
    from: RunParentSchema.mapFields(Struct.pick(['id', 'uid'])),
    at: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
]);
export type RunProvenance = typeof RunProvenanceSchema.Type;

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
  worktree: Schema.optional(Schema.NullOr(WorktreeInfoSchema)),
  /** The launching run with its creation coordinate; null for a root. */
  parent: Schema.NullOr(RunParentSchema),
  /** Null for a run that starts fresh. */
  provenance: Schema.NullOr(RunProvenanceSchema),
  /** The parent's tool card (its `logId`) whose call launched this run: an
   *  `agent` call's child, a `script` call's background run. Absent for a
   *  root and for a child no card launched. */
  parentCard: Schema.optional(
    Schema.NullOr(Schema.String.check(Schema.isMinLength(1))),
  ),
  /** The run's approval policy at launch, from the session's single authority. */
  approvalPolicy: Schema.optional(Schema.NullOr(ApprovalPolicySnapshotSchema)),
});

/** The run directories to remove with this lifecycle, derived by the database. */
const RunRemovedEventSchema = durable('run.removed', {
  runIds: Schema.Array(RunIdSchema),
});

/** A launcher names the parent; the database stamps its creation commit. */
const RunStartDraftSchema = RunStartEventSchema.mapFields(
  Struct.omit(['parent']),
).mapFields(
  Struct.assign({
    parent: Schema.NullOr(RunParentSchema.mapFields(Struct.omit(['uid']))),
  }),
);
const RunRemovedDraftSchema = RunRemovedEventSchema.mapFields(
  Struct.omit(['runIds']),
);

/** A row of a plugin's own kind (`Plugin.arms`): core folds `value`
 *  latest per (plugin, kind) and never reads it; the plugin decodes it. A
 *  run's is `RunView.facts`; a plugin aggregate's is `SessionView.pluginFacts`,
 *  under its `parent` run (whose deletion collects it) or none. */
export const PluginFactDraftSchema = durable('plugin.fact', {
  plugin: Schema.String.check(Schema.isMinLength(1)),
  kind: Schema.String.check(Schema.isMinLength(1)),
  /** The arm's version `value` was written at: a plugin evolves its
   *  kinds without a core row version. */
  version: Schema.Int.check(Schema.isGreaterThan(0)),
  value: JsonValueSchema,
  parent: Schema.NullOr(RunIdSchema),
}).mapFields(Struct.assign({ aggregateId: AggregateIdSchema }));

/**
 * The durable arms every renderer folds. This is the one declaration of the
 * run vocabulary: the trace's `AgentEvent` (`packages/harness/src/agent/trace/events.ts`) is
 * derived from these arms, minus the aggregate qualification. Session-scoped
 * arms carry the session facts with the payload flattened. `run.removed` is
 * the tombstone: the last row of its aggregate, final (PRD 5.2, "Existence").
 */
const DisplayRowDraftSchema = Schema.Union([
  /** Every activation of a run, the first launch and each resume (PRD 6,
   *  item 8); `run.start` is the creation fact and happens once. */
  durable('run.activate', {}),
  /** What the run runs with: the newest row's model and `binding` hold. */
  durable('run.config', {
    config: RunRecordFieldsSchema,
    binding: Schema.optional(Schema.NullOr(RunBindingSchema)),
  }),
  durable('run.model', { model: Schema.String.check(Schema.isMinLength(1)) }), // projected (`projections.ts`), never stored
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
  durable('run.end', RunEndRowSchema.fields),
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
   * `heldFor`: the delivery id of a result its parent refused while another
   * process held it, delivered when next admitted; `ends`: that turn's end.
   */
  durable('child.park', {
    phase: Schema.Literals(['parked', 'resumed', 'paused']),
    resumeId: Schema.optional(Schema.String),
    heldFor: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
    ends: Schema.optional(Schema.Literals(['completed', 'failed'])),
  }),
  /** A run's title, and who gave it: the model's summary, or the user's
   *  rename, which a later model title does not replace. */
  durable('run.description', {
    description: Schema.String,
    by: Schema.Literals(['model', 'user']),
  }),
  PluginFactDraftSchema,
  /** Input a run has not taken yet (one run model, section 3.7), whole, so
   *  a crash loses nothing; `followUpId` is the producer's delivery id or
   *  minted. Pending is queued without consumed. */
  durable('followup.queued', {
    followUpId: Schema.String.check(Schema.isMinLength(1)),
    content: FollowUpContentSchema,
    /** Held until a take also carries an instruction (a pause notice). */
    holdUntil: Schema.optional(Schema.Literals(['instruction'])),
    /** A request of the run's own, consumed by the batch that applies it. */
    control: Schema.optional(
      Schema.Union([
        Schema.Struct({ kind: Schema.Literal('compact') }),
        Schema.Struct({
          kind: Schema.Literal('model'),
          model: Schema.String.check(Schema.isMinLength(1)),
        }),
      ]),
    ),
  }),
  /** The follow-up became the message a turn carries, in that
   *  message's batch: never delivered twice. */
  durable('followup.consumed', {
    followUpId: Schema.String.check(Schema.isMinLength(1)),
  }),
  /**
   * A run asking a person (one run model, section 3.7): what the UI shows,
   * never host handles. Pending is opened without decided.
   */
  durable('request.opened', {
    requestId: Schema.String.check(Schema.isMinLength(1)),
    payload: PermissionPayloadSchema,
  }),
  /**
   * The answer, whatever surface gave it and whatever its provenance. The
   * decision is the durable recovery fact: a model retry (the `failed`
   * row that asks) reads its consent off this row, never off a snapshot
   * alone, and an automatic close names its cause here.
   */
  durable('request.decided', {
    requestId: Schema.String.check(Schema.isMinLength(1)),
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
  ...TranscriptEventSchema.mapMembers(Tuple.map(onRunAggregate)).members,
]);
/** Every display arm: the lifecycle pair (`run.start`, `run.removed`) and
 *  the rows between them. */
const DisplaySessionEventDraftSchema = Schema.Union([
  RunStartDraftSchema,
  RunRemovedDraftSchema,
  ...DisplayRowDraftSchema.members,
]);
/** The run's private records, read by the runtime and never by a renderer
 *  (`isDisplaySessionEvent`). `followup.closed`: its input is closed until a
 *  claim reopens it or it activates again. */
const RunRecordEventDraftSchema = Schema.Union([
  durable('run.report', { report: Schema.NullOr(Schema.String) }),
  durable('run.result', { result: ResultMetaSchema }),
  durable('followup.closed', {}),
]);
/**
 * The run history's private rows: the byte-exact conversation and the loop's durable state (its hooks'
 * outcomes included), read only by `applyRunRows` through `RunHistory`. Never
 * redacted, on a renderer's transport or in the cold listing.
 */
const RunHistoryEventDraftSchema = Schema.Union([
  durable('model.message', { payload: ModelMessagePayloadSchema }),
  durable('context.edit', { payload: ContextEditPayloadSchema }),
  durable('tool.intent', { payload: ToolIntentPayloadSchema }),
  /** A call a script issued, with its arguments: committed with its intent. */
  durable('script.call', { payload: ScriptCallPayloadSchema }),
  durable('tool.result', { payload: ToolResultPayloadSchema }),
  durable('tools.offered', { payload: ToolsOfferedPayloadSchema }),
  durable('context.blob', { payload: ContextBlobSchema }),
  durable('hook.outcome', { payload: HookOutcomePayloadSchema }),
  /**
   * One child turn's identity and fate, the child loop's own bookkeeping.
   * The key is structural, (run, attempt, turn index), so an accepted turn
   * always folds to one identity and a later attempt reusing the run id
   * never collides with it. `accepted` without `settled` is the active
   * turn; the latest `settled` is the last turn whose delivery ran: its
   * parent's `followup.queued` commits in the same transaction.
   */
  durable('child.turn', {
    attemptId: Schema.String.check(Schema.isMinLength(1)),
    turnIndex: Schema.Int.check(Schema.isGreaterThan(0)),
    phase: Schema.Literals(['accepted', 'settled']),
  }),
]);
export const SessionEventDraftSchema = Schema.Union([
  ...DisplaySessionEventDraftSchema.members,
  ...RunRecordEventDraftSchema.members,
  ...RunHistoryEventDraftSchema.members,
]);
/** Every member of a draft union with the envelope columns added. */
const withEnvelope = Tuple.map(Schema.fieldsAssign(envelope));
export const DisplaySessionEventSchema = Schema.Union([
  RunStartEventSchema.mapFields(Struct.assign(envelope)),
  RunRemovedEventSchema.mapFields(Struct.assign(envelope)),
  ...DisplayRowDraftSchema.mapMembers(withEnvelope).members,
]);
export type DisplaySessionEvent = typeof DisplaySessionEventSchema.Type;
export const SessionEventSchema = Schema.Union([
  ...DisplaySessionEventSchema.members,
  ...RunRecordEventDraftSchema.mapMembers(withEnvelope).members,
  ...RunHistoryEventDraftSchema.mapMembers(withEnvelope).members,
]);
export type SessionEvent = typeof SessionEventSchema.Type;

/**
 * What a publisher hands `SessionEvents.publish`: the body plus the aggregate
 * it lives on. The publisher stamps the rest of the envelope
 * (`seq`, `commit`, `origin`, `at`) under its permit; no caller passes them.
 * Parsing a draft removes caller-supplied envelope fields before storage.
 */
export type SessionEventDraft = typeof SessionEventDraftSchema.Type;

/** Aggregate identities introduced by a fact and its declared lifecycle edges. */
export function referencedAggregates(event: SessionEvent): AggregateId[] {
  const ids = [event.aggregateId];
  if (event.type === 'run.start' && event.parent !== null)
    ids.push(qualifyAggregateId('run', event.parent.id));
  if (event.type === 'plugin.fact' && event.parent !== null)
    ids.push(qualifyAggregateId('run', event.parent));
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
        parent: draft.parent && qualifyAggregateId('run', draft.parent.id),
        borrowsClaim: false,
        closes: false,
      };
    case 'plugin.fact': {
      if (aggregateTarget(draft.aggregateId).kind === 'run')
        return { parent: null, borrowsClaim: false, closes: false };
      const reparent =
        draft.parent === null ? null : qualifyAggregateId('run', draft.parent);
      return { parent: null, reparent, borrowsClaim: true, closes: false };
    }
    case 'run.removed':
      return { parent: null, borrowsClaim: false, closes: true };
    default:
      return { parent: null, borrowsClaim: false, closes: false };
  }
}

/**
 * The listing types the fold keys `latest` by: every durable arm
 * but the transcript tier. The request pair shares one entry because it
 * folds to one set, the follow-up pair likewise, and the lifecycle pair (`run.start`, `run.removed`)
 * shares one because it folds to one existence: a tombstone's commit then
 * outranks a replayed `run.start` below it, which is what makes the
 * tombstone final under every read. `run.position` is a
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
  DisplaySessionEventDraftSchema.members.map(
    (schema) => schema.fields.type.literal,
  ),
);

/** A run's private records and the profile-state rows never enter display transport. */
export function isDisplaySessionEvent(
  event: SessionEvent,
): event is DisplaySessionEvent {
  return DISPLAY_EVENT_TYPES.includes(event.type);
}
