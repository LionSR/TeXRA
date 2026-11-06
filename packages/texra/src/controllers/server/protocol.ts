/**
 * The TeXRA service protocol: one `RpcGroup`, served over the per-user
 * socket by `texra serve`. It names no transport, so the same handlers
 * also serve an in-memory client (`RpcTest.makeClient`) for a host that
 * embeds the engine. Every window is a client of it; the service owns
 * every task it starts.
 *
 * The payloads are the runtime's own wire schemas (the session bridge's
 * `Subscribe` and `EventsFrame`, `RuntimeRequest`, `StartRequestSchema`,
 * `AgentConfig`), used as
 * they are; a procedure's error is the error class the handler fails with,
 * which the client receives as that class. The procedures:
 *
 * - `service.hello`: the handshake; a client compares `protocol` with its own.
 * - `service.stop`: stop now (`drain: false`), or stop taking new work and
 *   exit once the running tasks end (`drain: true`, the upgrade path).
 * - `tasks.list`: every task in every project this storage root holds.
 * - `task.watch`: a project's session feed (a stream of `EventsFrame`s)
 *   for one `Subscribe`, the frames the webview bridge already carries.
 * - `task.request`: one `RuntimeRequest` (send, approve, stop, fork, a
 *   model switch, a pending tool edit's preview, …).
 * - `task.start` / `task.resume`: launch or continue a task in the service;
 *   `task.ended`: the outcome it ends with.
 * - `task.config` / `task.exportInput` / `task.exportTrace`: a task's saved
 *   setup, and what its transcript exports read, from the service's own
 *   records; `tasks.history`, `task.detail`, `task.skills` and
 *   `tasks.delete`: what the CLI's history and status read and delete.
 * - `host.attach` / `host.focus` / `host.answer`: a window offering its host
 *   capabilities to its project's tasks (see `hostCalls.ts`).
 * - `state.get` / `state.set`: the project's state store, which a window
 *   reads and writes here rather than opening the project's store itself.
 */
import { Schema, Struct } from 'effect';
import { Rpc, RpcGroup } from 'effect/rpc';

import {
  AgentConfigSchema,
  AgentRunListingEntrySchema,
  JsonValueSchema,
  LaunchNoticeSchema,
  RunEndSchema,
  RunIdSchema,
  RunRecordFieldsSchema,
  RunResultSchema,
  RunViewSchema,
  RunWorkspaceFileSchema,
  RUN_STATUS_KEYS,
  OutcomeSchema,
  RequestErrorSchema,
  RuntimeRequestSchema,
  StartRequestSchema,
} from '@texra-ai/harness/schemas';
import {
  CommitOrdinalSchema,
  DisplaySessionEventSchema,
} from '@texra-ai/harness/transcript';
import { ChatExportInputSchema } from '@texra/agent/export/schemas';

import {
  EventsFrameSchema,
  SubscribeSchema,
} from '@texra/shared/session/sessionFrames';
import {
  HostAnswerSchema,
  HostCapabilitySchema,
  HostFrameSchema,
} from './hostCalls';
import { ExportNodeSchema, type ValueFamily } from '@texra-ai/harness/host';

import { RUN_LAUNCH_FACT_FIELDS } from './taskList';

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

/** The protocol's version and the shapes it versions. `version` is bumped
 *  whenever a procedure or a payload changes shape: a client newer than the
 *  running service retires it, an older one stays in process. `shapes` holds
 *  each procedure's hash of its payload, success and error JSON Schemas at
 *  that version. `protocolVersion.vitest.ts` fails when one moves, and
 *  `npm run protocol:bump` advances the version and rewrites the hashes
 *  together. A hash sees what JSON Schema shows: an opaque `Schema.declare`
 *  or a `Schema.Json` field moves none. */
export const PROTOCOL: {
  readonly version: number;
  readonly shapes: Readonly<Record<string, string>>;
} = Object.freeze({
  version: 62,
  shapes: Object.freeze({
    'service.hello': 'b883cf64d52c',
    'service.stop': '8d19317aa364',
    'tasks.list': 'bc73391caaa8',
    'task.watch': '5408dac0ed30',
    'task.request': '5a7f109ea867',
    'task.start': 'bd10b36a735a',
    'task.resume': 'ac37fb4d0261',
    'task.ended': 'b8a10423576c',
    'task.config': 'ee42ee67ab23',
    'task.exportTrace': '885c1218814b',
    'task.exportInput': 'fefc9f82f1e2',
    'tasks.history': '9de0043e6a9e',
    'task.detail': '1bfa62e673dd',
    'task.skills': 'b842fcc8e960',
    'tasks.delete': 'd798ff938bde',
    'host.attach': '153808303ff7',
    'state.get': '221cc7263384',
    'state.set': 'e377b902a4e3',
    'host.focus': 'fd20627c2222',
    'host.answer': 'cc171cdead15',
  }),
});

/** What `service.hello` and `texra service status` report. */
export const ServiceInfoSchema = Schema.Struct({
  protocol: Schema.Int.check(Schema.isGreaterThan(0)),
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

/** The running service's record, claimed once it listens: where a client
 *  finds it. */
const ServiceRecordSchema = ServiceInfoSchema.mapFields(
  Struct.pick(['pid', 'protocol', 'version', 'startedAt']),
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
  statusKey: Schema.Literals(RUN_STATUS_KEYS),
  /** Launch time, ms since the epoch: the list's order. */
  launchedAt: Schema.Int.check(Schema.isGreaterThan(0)),
  /** This service runs it now, so it answers approvals and streams text. */
  live: Schema.Boolean,
});
export type TaskSummary = typeof TaskSummarySchema.Type;

/** The run a `task.start` or `task.resume` reached, and a commit inside the
 *  activation it reached: a window's handle reads that activation's events
 *  from the rows up to it, whatever later activation the run has by then. */
const TaskAdmitted = Schema.Struct({
  runId: RunIdSchema,
  activation: CommitOrdinalSchema,
});

/** Why `task.start` or `task.resume` did not reach its run. The service
 *  shows it nowhere: the window that asked presents it. */
export class TaskFailed extends Schema.TaggedError<TaskFailed>()('TaskFailed', {
  message: Schema.String,
  /** A refused launch's notice (an unknown model, an unknown agent), which
   *  the window shows in place of the message. */
  notice: Schema.optional(LaunchNoticeSchema),
}) {}

/** Why a task's records have no answer: the service holds no such run in
 *  the project, its records would not read, or (on the client side only) the
 *  service is offline or did not answer. */
export class TaskRecordsFailed extends Schema.TaggedError<TaskRecordsFailed>()(
  'TaskRecordsFailed',
  {
    runId: RunIdSchema,
    reason: Schema.Literals(['offline', 'unknownRun', 'unreadable']),
    message: Schema.String,
  },
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

/** The procedures, in one group. */
export const TexraRpcs = RpcGroup.make(
  Rpc.make('service.hello', {
    payload: { protocol: Schema.Number },
    success: ServiceInfoSchema,
  }),
  Rpc.make('service.stop', { payload: { drain: Schema.Boolean } }),
  Rpc.make('tasks.list', {
    /** `all`: every task, for resolving an id; otherwise the newest. */
    payload: { all: Schema.Boolean },
    success: Schema.Array(TaskSummarySchema),
  }),
  Rpc.make('task.watch', {
    payload: { workspace, subscribe: SubscribeSchema },
    success: EventsFrameSchema,
    error: TaskFailed,
    stream: true,
  }),
  Rpc.make('task.request', {
    payload: { workspace, request: RuntimeRequestSchema },
    success: OutcomeSchema,
    error: RequestErrorSchema,
  }),
  Rpc.make('task.start', {
    /** The start as the window's `session.start` took it, less the window's
     *  own tools, which a service cannot run: its case with a host's whole
     *  configuration, which the service takes and resolves nothing for. */
    payload: { workspace, start: StartRequestSchema.members[1] },
    /** The run that started: the asked id, or the one the launch resolved. */
    success: TaskAdmitted,
    error: TaskFailed,
  }),
  Rpc.make('task.resume', {
    payload: { workspace, runId: RunIdSchema },
    /** The run that resumed: the asked one, or the parent that owns it. */
    success: TaskAdmitted,
    error: TaskFailed,
  }),
  /** What a task's current activation ends with, once it ends: its
   *  stored end; and `at`, the service's view position where it saw the
   *  end, so a window's view at or past it shows the end (or the run's
   *  removal) too. */
  Rpc.make('task.ended', {
    payload: { workspace, runId: RunIdSchema },
    success: RunEndSchema.mapFields(Struct.assign({ at: CommitOrdinalSchema })),
    error: TaskFailed,
  }),
  /** The run's saved setup; null when it saved none. */
  Rpc.make('task.config', {
    payload: { workspace, runId: RunIdSchema },
    success: Schema.NullOr(AgentConfigSchema),
    error: TaskRecordsFailed,
  }),
  /** What the HTML transcript export reads: the run's display rows and its
   *  record (`assembleTrace`), or why it has none. */
  Rpc.make('task.exportTrace', {
    payload: { workspace, runId: RunIdSchema },
    success: Schema.Union([
      Schema.Struct({
        status: Schema.Literal('ok'),
        // A `TraceDocument`: the run's display rows, in commit order.
        trace: Schema.Struct({
          runId: RunIdSchema,
          events: Schema.Array(DisplaySessionEventSchema),
        }),
        record: RunRecordFieldsSchema,
      }),
      Schema.Struct({
        status: Schema.Literals(['config_missing', 'streamLogs_missing']),
      }),
    ]),
    error: TaskRecordsFailed,
  }),
  /** What the transcript export reads: the run's setup and the assembled
   *  input, each null when the run has none (`loadChatExportInput`). */
  Rpc.make('task.exportInput', {
    payload: { workspace, runId: RunIdSchema },
    success: Schema.Struct({
      config: Schema.NullOr(AgentConfigSchema),
      exportInput: Schema.NullOr(ChatExportInputSchema),
    }),
    error: TaskRecordsFailed,
  }),
  /** The runs a person started in the project, newest first, as a history
   *  list shows them (`LocalSession.listRuns`). */
  Rpc.make('tasks.history', {
    payload: { workspace },
    success: Schema.Array(AgentRunListingEntrySchema),
    error: TaskFailed,
  }),
  /** What a history detail reads of a run beyond its setup and its
   *  conversation: the launch facts its view holds (null for a run the
   *  view no longer lists), its result, its report, the workspace files it
   *  edited that are still there, and whether its rows hold a point to
   *  continue from. */
  Rpc.make('task.detail', {
    payload: { workspace, runId: RunIdSchema },
    success: Schema.Struct({
      run: Schema.NullOr(
        RunViewSchema.mapFields(Struct.pick(RUN_LAUNCH_FACT_FIELDS)),
      ),
      result: Schema.NullOr(RunResultSchema),
      report: Schema.NullOr(Schema.String),
      /** Its conversation as every conversation view renders it. */
      conversation: Schema.Array(ExportNodeSchema),
      workspaceFiles: Schema.Array(RunWorkspaceFileSchema),
      resumable: Schema.Boolean,
    }),
    error: TaskRecordsFailed,
  }),
  /** The skills the run's latest step listed. */
  Rpc.make('task.skills', {
    payload: { workspace, runId: RunIdSchema },
    success: Schema.Array(Schema.String),
    error: TaskRecordsFailed,
  }),
  /** Delete one stored run, or every one (`LocalSession.deleteRuns`): a run
   *  the service still runs is skipped and reported as `active`. */
  Rpc.make('tasks.delete', {
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
  Rpc.make('host.attach', {
    payload: {
      workspace,
      capabilities: Schema.Array(HostCapabilitySchema),
    },
    success: HostFrameSchema,
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
