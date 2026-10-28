/**
 * The TeXRA service protocol: one `RpcGroup`, served over the per-user
 * socket by `texra serve`. It names no transport, so the same handlers
 * also serve an in-memory client (`RpcTest.makeClient`) for a host that
 * embeds the engine. Every window is a client of it; the service owns
 * every task it starts.
 *
 * The payloads are the runtime's own wire schemas (the session bridge's
 * `Subscribe` and `EventsFrame`, `RuntimeRequest`, `AgentConfig`), used as
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
 *   records.
 * - `host.attach` / `host.focus` / `host.answer`: a window offering its host
 *   capabilities to its project's tasks (see `hostCalls.ts`).
 * - `state.get` / `state.set`: the project's state store, which a window
 *   reads and writes here rather than opening the project's store itself.
 */
import { Schema, Struct } from 'effect';
import { Rpc, RpcGroup } from 'effect/rpc';

import {
  AgentConfigSchema,
  JsonValueSchema,
  RunEndSchema,
  RunIdSchema,
  RunRecordFieldsSchema,
  ApprovalPolicySchema,
  RUN_STATUS_KEYS,
  OutcomeSchema,
  RequestErrorSchema,
  RuntimeRequestSchema,
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
import type { ValueFamily } from '@texra-ai/harness/host';

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

/** Bumped whenever a procedure or a payload changes shape. A client newer
 *  than the running service retires it; an older one stays in process. */
export const PROTOCOL_VERSION = 35;

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
export const TEXRA_SERVICE: ValueFamily<ServiceRecord, true> = {
  name: 'texra-service',
  schema: ServiceRecordSchema,
  deletable: true,
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

/** Why `task.start` or `task.resume` did not reach its run. */
export class TaskFailed extends Schema.TaggedError<TaskFailed>()('TaskFailed', {
  message: Schema.String,
  /** The service already presented it, through the window attached to the
   *  project: the caller does not present it again. */
  presented: Schema.optional(Schema.Boolean),
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
    payload: {
      workspace,
      runId: RunIdSchema,
      config: AgentConfigSchema,
      /** The chat's previous root: its bypass settings carry over. */
      continues: Schema.NullOr(RunIdSchema),
      /** Run on the configured helper model (the "fix LaTeX" actions). */
      preferHelperModel: Schema.Boolean,
      /** An Auto-approve launch: the run starts with delegated work
       *  approved, as the run header's switch would set it. */
      approveDelegatedWork: Schema.Boolean,
      /** The policy the launch asked for: one stricter than the project's
       *  narrows this task only; a more permissive one is ignored. */
      approvalPolicy: Schema.NullOr(ApprovalPolicySchema),
    },
    /** The run that started: the asked id, or the one the launch resolved. */
    success: TaskAdmitted,
    error: TaskFailed,
  }),
  Rpc.make('task.resume', {
    payload: { workspace, runId: RunIdSchema },
    /** The run that resumed: the asked one, or the parent that owns it;
     *  null when something it needs (its agent, a plugin) is missing, so it
     *  stays interrupted. */
    success: Schema.NullOr(TaskAdmitted),
    error: TaskFailed,
  }),
  /** What a task's current activation ends with, once it ends: its
   *  outcome, output, and the error a failed one ended with; and `at`,
   *  the service's fold position where it saw the end, so a window's
   *  fold at or past it shows the end (or the run's removal) too. */
  Rpc.make('task.ended', {
    payload: { workspace, runId: RunIdSchema },
    success: RunEndSchema.mapFields(
      Struct.pick(['outcome', 'output', 'error']),
    ).mapFields(
      Struct.assign({
        at: CommitOrdinalSchema,
      }),
    ),
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
