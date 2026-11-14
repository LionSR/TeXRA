/**
 * The TeXRA service protocol: one `RpcGroup`, served over the per-user
 * socket by `texra serve`. It names no transport, so the same handlers
 * also serve an in-memory client (`RpcTest.makeClient`) for a host that
 * embeds the engine. Every window is a client of it; the service owns
 * every task it starts.
 *
 * The payloads are the runtime's own wire schemas (the session bridge's
 * `Subscribe` and `EventsFrame`, `RuntimeCommand`, `StartRequestSchema`,
 * `AgentConfig`), used as
 * they are; a procedure's error is the error class the handler fails with,
 * which the client receives as that class. The procedures:
 *
 * - `service.hello`: the handshake; a client compares `protocol` (the
 *   digest of every procedure's shapes, {@link PROTOCOL}) with its own.
 * - `service.stop`: stop now (`drain: false`), or stop taking new work and
 *   exit once the running tasks end (`drain: true`, the upgrade path).
 * - `tasks.list`: every task in every project this storage root holds.
 * - `task.watch`: a project's session feed (a stream of `EventsFrame`s)
 *   from a cursor, with the transcripts named, the frames the webview
 *   bridge already carries.
 * - `task.request`: one `RuntimeCommand` (send, approve, stop, fork, a
 *   model switch, a pending tool edit's preview, …).
 * - `task.start` / `task.resume`: launch or continue a task in the service,
 *   answered with the run and the activation the window's handle is for;
 *   `task.result`: that activation's stored end (`Run.result`).
 * - `session.view` / `session.listRuns` / `session.deleteRuns` and the
 *   `records.*` procedures ({@link RUN_RECORDS}): `Session`'s store reads and
 *   deletion, one procedure per member, answered from the service's own
 *   session.
 * - `host.attach` / `host.focus` / `host.answer`: a window offering its host
 *   capabilities to its project's tasks (see `hostCalls.ts`).
 * - `state.get` / `state.set`: the project's state store, which a window
 *   reads and writes here rather than opening the project's store itself.
 */
import { hash } from 'node:crypto';

import { type Effect, Schema, Struct } from 'effect';
import { Rpc, RpcGroup, RpcSchema } from 'effect/rpc';

import { LaunchRefused, type RunRecords } from '@texra-ai/harness';
import {
  AgentConfigSchema,
  AgentRunListingEntrySchema,
  JsonValueSchema,
  ResumeRefusalSchema,
  RunEndSchema,
  RunIdSchema,
  RunRecordFieldsSchema,
  RunResultSchema,
  RunWorkspaceFileSchema,
  OutcomeSchema,
  RequestErrorSchema,
  RuntimeCommandSchema,
  SessionViewSchema,
  StartRequestSchema,
} from '@texra-ai/harness/schemas';
import { RunStatusKeySchema } from '@texra/shared/session/runStatusKey';
import {
  CommitOrdinalSchema,
  DisplayRowSchema,
} from '@texra-ai/harness/transcript';

import {
  EventsFrameSchema,
  SubscribeSchema,
} from '@texra/shared/session/sessionFrames';
import { BridgeErrorSchema } from '@texra/shared/session/bridgeErrors';
import {
  HostAnswerSchema,
  HostCapabilitySchema,
  HostAttachFrameSchema,
} from './hostCalls';
import { ExportNodeSchema, type ValueFamily } from '@texra-ai/harness/host';

/**
 * The build every TeXRA bundle carries: the workspace version, stamped by
 * each bundler (`process.env.TEXRA_BUILD_VERSION`, replaced at build time).
 * The service reports it and a client retires an older one by it. It is not
 * a host product's own version: a preview VSIX is renumbered for the
 * Marketplace while the CLI and the desktop app of the same build are not,
 * so comparing those would retire a service of the very same build. An
 * unbundled run (tests, `tsx`) is `unknown`, which retires nothing.
 */
export const BUILD_VERSION: string =
  process.env.TEXRA_BUILD_VERSION || 'unknown';

/** What `service.hello` and `texra service status` report. */
export const ServiceInfoSchema = Schema.Struct({
  /** The protocol the service speaks: {@link PROTOCOL}'s digest. */
  protocol: Schema.String.check(Schema.isMinLength(1)),
  /** The build that is serving: the package version. */
  version: Schema.String,
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  /** Where clients connect: the Unix socket path. */
  socket: Schema.String,
  startedAt: Schema.Int.check(Schema.isGreaterThan(0)),
  clients: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Tasks this service is running now, across its projects. */
  running: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** A drain is in progress: no new task starts here. */
  draining: Schema.Boolean,
});
export type ServiceInfo = typeof ServiceInfoSchema.Type;

/** The record a storage root's service claims once it listens, where a
 *  client finds it: a pointer to its socket.
 *  Its protocol and build are the hello's, read from the socket. */
const ServiceRecordSchema = ServiceInfoSchema.mapFields(
  Struct.pick(['pid', 'startedAt']),
).mapFields(
  Struct.assign({ socket: Schema.String.check(Schema.isMinLength(1)) }),
);
export type ServiceRecord = typeof ServiceRecordSchema.Type;

/** The storage root's running service: one row of the global root's
 *  current values, read and changed under its write lock. */
export const TEXRA_SERVICE: ValueFamily<ServiceRecord> = {
  name: 'texra-service',
  schema: ServiceRecordSchema,
};

/** One top-level task in `tasks.list`. */
const TaskSummarySchema = Schema.Struct({
  /** The project folder the task works in: what the other procedures take. */
  workspace: Schema.String,
  runId: RunIdSchema,
  label: Schema.String,
  description: Schema.NullOr(Schema.String),
  statusKey: RunStatusKeySchema,
  /** Launch time, ms since the epoch: the list's order. */
  launchedAt: Schema.Int.check(Schema.isGreaterThan(0)),
  /** This service runs it now, so it answers approvals and streams text. */
  live: Schema.Boolean,
});
export type TaskSummary = typeof TaskSummarySchema.Type;

/** The run a `task.start` or `task.resume` reached, and the commit of the
 *  activation it reached (`Run.activation`): a window's handle is for that
 *  activation, whatever later activation the run has by then. */
const TaskAdmitted = Schema.Struct({
  runId: RunIdSchema,
  activation: CommitOrdinalSchema,
});

/** Why `task.start` or `task.resume` did not reach its run, past a refused
 *  launch (`LaunchRefused`, carried as itself). The service shows it
 *  nowhere: the window that asked presents it. */
export class TaskFailed extends Schema.TaggedError<TaskFailed>()('TaskFailed', {
  message: Schema.String,
}) {}

/** What `task.start` and `task.resume` fail with. */
const TaskStartFailed = Schema.Union([TaskFailed, LaunchRefused]);

/** Why a run's records have no answer: the service could not open the
 *  project, or its store refused the read. */
export class TaskRecordsFailed extends Schema.TaggedError<TaskRecordsFailed>()(
  'TaskRecordsFailed',
  { runId: RunIdSchema, message: Schema.String },
) {}

/** Why the project's state has no answer: the service could not open the
 *  project, or its store refused the read or the write. */
export class ProjectStateFailed extends Schema.TaggedError<ProjectStateFailed>()(
  'ProjectStateFailed',
  { message: Schema.String },
) {}

/** A state key's stored value: `value` absent when the key is unset. */
const StoredStateSchema = Schema.Struct({
  value: Schema.optional(JsonValueSchema),
});

/** The project a call addresses: its folder, as the client spells it. */
const workspace = Schema.String;

/**
 * `Session.records(runId)`, one procedure per member named `records.<member>`
 * (`records.readConfig`): what each answers with. A run the store does not
 * hold reads as absent, as it does there.
 */
export const RUN_RECORDS = {
  exists: Schema.Boolean,
  readConfig: Schema.NullOr(AgentConfigSchema),
  readReport: Schema.NullOr(Schema.String),
  readRunEnd: Schema.NullOr(RunEndSchema),
  readResult: Schema.NullOr(RunResultSchema),
  readWorkspaceFiles: Schema.Array(RunWorkspaceFileSchema),
  readSkills: Schema.Array(Schema.String),
  readResumable: Schema.Boolean,
  readRejection: Schema.NullOr(ResumeRefusalSchema),
  /** The run's conversation as every conversation view renders it. */
  readConversation: Schema.Array(ExportNodeSchema),
  /** What the HTML transcript export reads: the run's display rows and its
   *  record (`assembleTrace`), or why it has none. */
  readTrace: Schema.Union([
    Schema.Struct({
      status: Schema.Literal('ok'),
      // A `TraceDocument`: the run's display rows, in commit order.
      trace: Schema.Struct({
        runId: RunIdSchema,
        events: Schema.Array(DisplayRowSchema),
      }),
      record: RunRecordFieldsSchema,
    }),
    Schema.Struct({
      status: Schema.Literals(['config_missing', 'streamLogs_missing']),
    }),
  ]),
} satisfies {
  readonly [K in keyof RunRecords]: Schema.Codec<
    Effect.Success<RunRecords[K]>,
    unknown
  >;
};
type RecordMember = keyof typeof RUN_RECORDS;
const recordPayload = { workspace, runId: RunIdSchema };
/** The procedure of each member of {@link RUN_RECORDS}. */
export type RecordRpc = {
  readonly [K in RecordMember]: Rpc.Rpc<
    `records.${K}`,
    Schema.Struct<typeof recordPayload>,
    (typeof RUN_RECORDS)[K],
    typeof TaskRecordsFailed
  >;
}[RecordMember];
// cast: `Rpc.make` over a computed tag types it `string`; each entry is
// the `RecordRpc` of its member by construction.
const RECORD_RPCS = Struct.keys(RUN_RECORDS).map((member) =>
  Rpc.make(`records.${member}`, {
    payload: recordPayload,
    success: RUN_RECORDS[member],
    error: TaskRecordsFailed,
  }),
) as ReadonlyArray<RecordRpc>;

/** The procedures, in one group. */
export const TexraRpcs = RpcGroup.make(
  Rpc.make('service.hello', {
    payload: { protocol: Schema.String },
    success: ServiceInfoSchema,
  }),
  Rpc.make('service.stop', { payload: { drain: Schema.Boolean } }),
  Rpc.make('tasks.list', {
    /** `all`: every task, for resolving an id; otherwise the newest. */
    payload: { all: Schema.Boolean },
    success: Schema.Array(TaskSummarySchema),
  }),
  Rpc.make('task.watch', {
    // `workspace` names the project; the frames name the session. The
    // watch is one ordered stream, so it takes no generation.
    payload: {
      workspace,
      subscribe: SubscribeSchema.mapFields(
        Struct.pick(['debug', 'cursor', 'aggregates']),
      ),
    },
    success: EventsFrameSchema,
    error: TaskFailed,
    stream: true,
  }),
  Rpc.make('task.request', {
    payload: { workspace, request: RuntimeCommandSchema },
    success: OutcomeSchema,
    error: BridgeErrorSchema,
  }),
  Rpc.make('task.start', {
    /** The start as the window's `session.start` took it, less the window's
     *  own tools, which a service cannot run: its case with a host's whole
     *  configuration, which the service takes and resolves nothing for. */
    payload: { workspace, start: StartRequestSchema.members[1] },
    /** The run that started: the asked id, or the one the launch resolved. */
    success: TaskAdmitted,
    error: TaskStartFailed,
  }),
  Rpc.make('task.resume', {
    /** `apiKeys`: as a start carries them (`StartOptions.apiKeys`). */
    payload: {
      workspace,
      runId: RunIdSchema,
      apiKeys: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    },
    /** The run that resumed: the asked one, or the parent that owns it. */
    success: TaskAdmitted,
    error: TaskStartFailed,
  }),
  /** What the task's activation at `activation` ends with, once it ends:
   *  its stored end (`Run.result`, which fails when none was stored or it
   *  cannot be read); and `at`, the service's log position once its view
   *  showed the end, so a window's view at or past it shows the end (or the
   *  run's removal) too. */
  Rpc.make('task.result', {
    payload: TaskAdmitted.mapFields(Struct.assign({ workspace })),
    success: RunEndSchema.mapFields(Struct.assign({ at: CommitOrdinalSchema })),
    error: TaskFailed,
  }),
  /** `Session.view.read`: a snapshot built from the store, with the full
   *  transcript of the runs named. */
  Rpc.make('session.view', {
    payload: { workspace, runIds: Schema.Array(RunIdSchema) },
    success: SessionViewSchema,
    error: TaskFailed,
  }),
  /** `Session.listRuns`: the runs a person started in the project, newest
   *  first. */
  Rpc.make('session.listRuns', {
    payload: { workspace },
    success: Schema.Array(AgentRunListingEntrySchema),
    error: TaskFailed,
  }),
  /** `Session.deleteRuns`: delete one stored run, or every one; a run the
   *  service still runs is skipped and reported as `active`. */
  Rpc.make('session.deleteRuns', {
    payload: {
      workspace,
      target: Schema.Union([RunIdSchema, Schema.Literal('all')]),
    },
    success: Schema.Struct({
      listed: Schema.Int,
      deleted: Schema.Array(RunIdSchema),
      active: Schema.Array(RunIdSchema),
      failed: Schema.Array(
        Schema.Struct({ runId: RunIdSchema, error: RequestErrorSchema }),
      ),
    }),
    error: TaskFailed,
  }),
  ...RECORD_RPCS,
  Rpc.make('host.attach', {
    payload: {
      workspace,
      capabilities: Schema.Array(HostCapabilitySchema),
    },
    success: HostAttachFrameSchema,
    error: TaskFailed,
    stream: true,
  }),
  /** A key of the project's state store, as it is stored now. */
  Rpc.make('state.get', {
    payload: { workspace, key: Schema.String },
    success: StoredStateSchema,
    error: ProjectStateFailed,
  }),
  /** Store `next` under a key of the project's state store (an absent
   *  value clears it); with `ifCurrent`, only while the stored value is
   *  still that one. Answers whether it was written. */
  Rpc.make('state.set', {
    payload: {
      workspace,
      key: Schema.String,
      next: StoredStateSchema,
      ifCurrent: Schema.NullOr(StoredStateSchema),
    },
    success: Schema.Boolean,
    error: ProjectStateFailed,
  }),
  Rpc.make('host.focus', { payload: { attachment: Schema.String } }),
  Rpc.make('host.answer', {
    payload: { id: Schema.String, answer: HostAnswerSchema },
  }),
);

/** First 12 hex digits of the sha256 of a value's JSON text. */
const digest12 = (value: unknown): string =>
  hash('sha256', JSON.stringify(value), 'hex').slice(0, 12);

/** A procedure's shape: its payload, success and error schemas as JSON
 *  Schema, digested. A stream's success is its element and its error. What
 *  JSON Schema does not show (an opaque `Schema.declare`, a `Schema.Json`
 *  field) is not in the shape. */
const shapeOf = (rpc: Rpc.AnyWithProps): string => {
  const success = rpc.successSchema;
  const schemas = RpcSchema.isStreamSchema(success)
    ? [rpc.payloadSchema, success.success, success.error, rpc.errorSchema]
    : [rpc.payloadSchema, success, rpc.errorSchema];
  return digest12(schemas.map((schema) => Schema.toJsonSchemaDocument(schema)));
};

const shapes: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    [...TexraRpcs.requests].map(([tag, rpc]) => [tag, shapeOf(rpc)]),
  ),
);

/**
 * The protocol's identity: `shapes`, each procedure's shape as the module
 * loads, and `digest`, the digest of all of them. A client and a service
 * with one digest speak the same protocol; with two, the newer build
 * retires the older (`isOlder`, `client.ts`), and a build that is neither
 * (a development build) restarts the service. `service.hello` and
 * `service.stop` keep their shapes across versions, so an older client can
 * still stop a newer service (`protocolStability.vitest.ts` pins them).
 */
export const PROTOCOL: {
  readonly digest: string;
  readonly shapes: Readonly<Record<string, string>>;
} = Object.freeze({
  digest: digest12(
    Object.entries(shapes).toSorted(([a], [b]) => a.localeCompare(b)),
  ),
  shapes,
});
