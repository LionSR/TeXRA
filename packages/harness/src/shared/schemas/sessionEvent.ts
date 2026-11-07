/**
 * The durable session events every process applies to its `SessionView`.
 * The other view inputs, which never carry a seq, are in
 * `sessionViewInput.ts`.
 *
 * Every durable arm rides one envelope: the aggregate it belongs to, its
 * per-aggregate `seq`, the store-local `commit` cursor, the writing `origin`
 * and the publish clock; its durable identity is its aggregate's `uid` and
 * its `seq`. The arms mirror the trace (`AgentEvent`) shapes field for field
 * where the fold reads them, so a publisher translates by naming fields.
 *
 * One run owns one aggregate, `('run', runId)`:
 * display rows and the run's private records land on the same aggregate, and
 * whether a row reaches a renderer is a property of its type
 * (`isDisplaySessionEvent`), not of a second aggregate.
 *
 * Layering: this module lives under `packages/harness/src/shared/schemas` so
 * the view update and the transport stay free of `@agent/*`. Nothing checks
 * that edge; `shared/` imports no `@agent/*` module by convention.
 */
import { Schema, Struct, Tuple } from 'effect';

import { ApprovalPolicySnapshotSchema } from '@shared/approvalBypassKind';
import {
  AggregateIdSchema,
  OwnerIdSchema,
  aggregateTarget,
  qualifyAggregateId,
  type AggregateId,
} from './identifiers';
import { JsonValueSchema } from './jsonValue';
import { listingTypeOf } from './rowVersions';
import {
  RunEndRowSchema,
  RunRecordFieldsSchema,
  ProcessExitSchema,
  RunStopReasonSchema,
} from './runRecords';
import { RunIdSchema } from './identifiers';
import { FollowUpDispositionSchema, FollowUpRequestSchema } from './followUp';
import { RequestPayloadSchema, RequestDecisionSchema } from './request';
import { RunIdentitySchema } from './runIdentity';
import { NormalizedUsageSchema, RunBindingSchema } from './runInput';
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
import { WorktreeInfoSchema } from './run';
import { TranscriptEventSchema } from './traceEvent';

/** Per-aggregate append order; `run.start` is seq 1 of its run. Dense from
 *  1, assigned by the substrate's publisher and by nothing else. */
const SeqSchema = Schema.Int.check(Schema.isGreaterThan(0));
const NonEmpty = Schema.String.check(Schema.isMinLength(1));

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

/** The aggregate column of a `type` row, checked to be a run aggregate. */
function aggregateIdOf(type: string) {
  return AggregateIdSchema.check(
    Schema.makeFilter((key) => aggregateTarget(key).kind === 'run', {
      message: `Expected a run aggregate for ${type}`,
    }),
  );
}

function durable<T extends string, const F extends Schema.Struct.Fields>(
  type: T,
  fields: F,
) {
  return Schema.Struct({
    aggregateId: aggregateIdOf(type),
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
      aggregateId: aggregateIdOf(schema.fields.type.literal),
    }),
  ),
);

/**
 * The parent edge: the whole of it. `id` is the
 * launching run; `uid` is that run's incarnation, stamped by the database
 * inside the child's creation transaction so a logical id a retry reuses
 * can never redirect the child to a later incarnation of its parent. Any other spelling of the edge is `parent !== null`, computed from
 * the fold or the handle.
 */
const RunParentSchema = Schema.Struct({
  id: RunIdSchema,
  uid: Schema.String.check(Schema.isUUID()),
  /** The parent's tool call that launched this run (an `agent` call's
   *  child, a background `script` run), which owns it until it detaches,
   *  with its tool card (`logId`: a provider may reuse a call id, never a
   *  card); null for a child no call launched. `awaited`: the call reads
   *  the child's end itself, so the end delivers nothing to the parent's
   *  input; a background child's end is queued on it. */
  call: Schema.NullOr(
    Schema.Struct({
      callId: NonEmpty,
      card: NonEmpty,
      awaited: Schema.Boolean,
    }),
  ),
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
 * exists, once per incarnation, seq 1 of its aggregate; the
 * aggregate's logical id is the run id, so the row carries no second copy of
 * it. `worktree` is absent for a run that executes in the workspace itself
 * rather than in a dedicated worktree. `category`
 * and `takesFollowUps` are explicit on every run: the
 * launcher knows them for an agent, a process, and a script alike,
 * and the fold reads them verbatim and derives nothing. The
 * initial approval-policy snapshot rides here rather than as its own event:
 * under the latest-of-type rule a run never edited would
 * otherwise have no policy entry, and on the payload it is atomic with the
 * run's existence.
 */
const RunStartEventSchema = durable('run.start', {
  identity: RunIdentitySchema,
  /** Whether the run takes a message (a person's or a parent's) as its
   *  next cycle: a process run and a headless one-shot root take none. */
  takesFollowUps: Schema.Boolean,
  worktree: Schema.optional(Schema.NullOr(WorktreeInfoSchema)),
  /** The launching run with its creation coordinate; null for a root. */
  parent: Schema.NullOr(RunParentSchema),
  /** Null for a run that starts fresh. */
  provenance: Schema.NullOr(RunProvenanceSchema),
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

/** A row of a plugin's own kind (`Plugin.factKinds`): core folds `value`
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
 * run vocabulary: the trace's `AgentEvent` (`shared/session/agentEvent.ts`) is
 * derived from these arms, minus the aggregate qualification. Session-scoped
 * arms carry the session facts with the payload flattened. `run.removed` is
 * the deletion marker: the last row of its aggregate, final.
 */
const DisplayRowDraftSchema = Schema.Union([
  /** Every activation of a run, the first launch and each resume;
   *  `run.start` is the creation fact and happens once. */
  durable('run.activate', {}),
  /** What the run runs with: the newest row's model and `binding` hold. */
  durable('run.config', {
    config: RunRecordFieldsSchema,
    binding: Schema.optional(Schema.NullOr(RunBindingSchema)),
  }),
  /** The parent edge severed by a stop that detaches the run: the only
   *  fact after `run.start` that moves the edge. */
  durable('run.detach', {}),
  /**
   * A stop asked of the run, and why: a person's, or this process's
   * shutdown. Committed before the run's fiber is interrupted, so the end
   * that follows reads the reason here; a run with no fiber here ends in
   * the same batch. The one row every reader of "why it stopped" reads.
   */
  durable('run.stop', { reason: RunStopReasonSchema }),
  /**
   * The terminal fact: outcome, the classified error behind a failure, and
   * a tool-use run's reply (usage and workflow files have their own rows).
   * Written once per lifecycle, by the storage finalizer, after the run's
   * last transcript row; the fold derives the terminal phase from it and
   * from nothing else.
   */
  durable('run.end', RunEndRowSchema.fields),
  /** A run's title, and who gave it: the model's summary, or the user's
   *  rename, which a later model title does not replace. `usage` is the
   *  priced helper request that wrote a model's summary, part of the run's
   *  spend; absent when no request was priced (a rename, a launch's label,
   *  a fork's copy). */
  durable('run.description', {
    description: Schema.String,
    by: Schema.Literals(['model', 'user']),
    usage: Schema.optional(NormalizedUsageSchema),
  }),
  /** Input a run has not taken yet, whole, so a crash loses nothing;
   *  `followUpId` is the producer's delivery id or minted. Pending is
   *  queued without consumed. */
  durable('followup.queued', {
    followUpId: Schema.String.check(Schema.isMinLength(1)),
    ...FollowUpRequestSchema.fields,
  }),
  /** The follow-up left the queue, in the batch of the rows that took it,
   *  and why (`disposition`: part of a turn's message, answered, applied,
   *  or dropped with its reason): never delivered twice. */
  durable('followup.consumed', {
    followUpId: Schema.String.check(Schema.isMinLength(1)),
    disposition: FollowUpDispositionSchema,
  }),
  /** A run asking a person: what the UI shows, never host handles.
   *  Pending is opened without decided. */
  durable('request.opened', {
    requestId: Schema.String.check(Schema.isMinLength(1)),
    payload: RequestPayloadSchema,
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
  PluginFactDraftSchema,
  ...DisplayRowDraftSchema.members,
]);
/** The run's private records, read by the runtime and never by a renderer
 *  (`isDisplaySessionEvent`). `followup.closed`: its input is closed until a
 *  claim reopens it or it activates again. */
const RunRecordEventDraftSchema = Schema.Union([
  durable('run.report', { report: Schema.NullOr(Schema.String) }),
  /** How a process run's command exited, written with its end; a stop
   *  writes none (the interruption is the fact). */
  durable('process.exit', ProcessExitSchema.fields),
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
  /** As read: `unavailable` says why this process leaves `value` as
   *  written, uninterpreted (`unavailableFactReason`); never stored. */
  PluginFactDraftSchema.mapFields(
    Struct.assign({ ...envelope, unavailable: Schema.optional(Schema.String) }),
  ),
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
 * transaction alone, and the closure a deletion marker makes.
 * {@link referencedAggregates} reads the same edges off committed rows.
 * Every kind has a case, so a new kind does not compile until its edges are
 * decided here.
 */
interface AggregateEdges {
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
    case 'run.activate':
    case 'run.config':
    case 'run.detach':
    case 'run.stop':
    case 'run.end':
    case 'run.description':
    case 'followup.queued':
    case 'followup.consumed':
    case 'request.opened':
    case 'request.decided':
    case 'approval.policy':
    case 'run.position':
    case 'log':
    case 'stage.start':
    case 'stage.end':
    case 'tool.start':
    case 'tool.end':
    case 'usage':
    case 'context.state':
    case 'stream.start':
    case 'stream.end':
    case 'response.finalized':
    case 'process.output':
    case 'run.report':
    case 'process.exit':
    case 'followup.closed':
    case 'model.message':
    case 'context.edit':
    case 'tool.intent':
    case 'script.call':
    case 'tool.result':
    case 'tools.offered':
    case 'context.blob':
    case 'hook.outcome':
      return { parent: null, borrowsClaim: false, closes: false };
  }
}

/**
 * The `latest` key one row folds under: its listing type, qualified by the
 * row's own discriminator where it carries one. The mirror of the listing
 * query's `GROUP BY`, so "the newest row the fold holds" means the same
 * thing on a cold read and on a replay: one plugin kind's newest row never
 * suppresses another's.
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
  return type;
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

/** Every `AgentEvent` arm but the chunk: each is stored as a row of its run. */
// prettier-ignore
export const TRACE_ROW_TYPES = Object.freeze(['log', 'process.output', 'stage.start', 'stage.end', 'tool.start', 'tool.end', 'usage', 'context.state', 'stream.start', 'stream.end'] as const satisfies readonly DisplaySessionEvent['type'][]);

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
