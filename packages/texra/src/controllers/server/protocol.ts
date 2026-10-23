/**
 * The TeXRA service protocol: one `RpcGroup`, served over the per-user
 * socket by `texra serve`. It names no transport, so the same handlers
 * also serve an in-memory client (`RpcTest.makeClient`) for a host that
 * embeds the engine. Every window is a client of it; the service owns
 * every task it starts.
 *
 * The payloads are the runtime's own Zod wire shapes (the session bridge's
 * `Subscribe` and `EventsFrame`, `RuntimeRequest`, `AgentConfig`). Each
 * crosses the RPC edge through {@link zodWire}, a thin Effect Schema whose
 * decode is the Zod parse, so Zod stays the single source of truth. The
 * procedures:
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
import { Effect, Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/rpc';
import * as SchemaIssue from 'effect/SchemaIssue';
import { z } from 'zod';

import {
  AgentConfigSchema,
  JsonValueSchema,
  RunEndSchema,
  RunIdSchema,
  RunRecordFieldsSchema,
  ApprovalPolicySchema,
  RUN_STATUS_KEYS,
  OutcomeSchema,
  RuntimeRequestSchema,
} from '@texra-ai/harness/schemas';
import {
  CommitOrdinalSchema,
  DisplaySessionEventSchema,
} from '@texra-ai/harness/transcript';
import { ChatExportInputSchema } from '@texra/agent/export/schemas';

import {
  EventsFrameSchema,
  RequestErrorWireSchema,
  SubscribeSchema,
} from '@texra/shared/session/sessionFrames';
import {
  HostAnswerSchema,
  HostCapabilitySchema,
  HostFrameSchema,
} from './hostCalls';
import type { ValueFamily } from '@texra-ai/harness';

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
export const PROTOCOL_VERSION = 32;

/** `value` as JSON carries it: an absent field (`undefined`) is left out,
 *  which the wire's JSON check otherwise refuses. */
function jsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonValue);
  if (
    value === null ||
    typeof value !== 'object' ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, field]) =>
      field === undefined ? [] : [[key, jsonValue(field)]],
    ),
  );
}

/**
 * A Zod schema as an Effect Schema at the RPC edge: decoding runs the Zod
 * parse (defaults and preprocessing included) and fails with the Zod
 * message; the encoded form is the JSON value itself.
 */
function zodWire<T extends z.ZodType>(
  schema: T,
): Schema.declareConstructor<z.output<T>, z.output<T>, readonly []> {
  return Schema.declareConstructor<z.output<T>, z.output<T>>()(
    [],
    () => (input, _ast, options) => {
      const parsed = schema.safeParse(input);
      return parsed.success
        ? Effect.succeed(jsonValue(parsed.data) as z.output<T>)
        : Effect.fail(
            new SchemaIssue.InvalidValue(
              { message: z.prettifyError(parsed.error) },
              input,
              options,
            ),
          );
    },
  );
}

/** What `service.hello` and `texra service status` report. */
const ServiceInfoSchema = z.object({
  protocol: z.int().positive(),
  /** The build that is serving: the package version. */
  version: z.string(),
  pid: z.int().positive(),
  /** Where clients connect: the Unix socket path. */
  socket: z.string(),
  startedAt: z.int().positive(),
  clients: z.int().nonnegative(),
  /** Tasks this service is running now, across its projects. */
  running: z.int().nonnegative(),
  /** A drain is in progress: no new task starts here. */
  draining: z.boolean(),
});
export type ServiceInfo = z.infer<typeof ServiceInfoSchema>;

/** The running service's record, claimed once it listens: where a client
 *  finds it. */
const ServiceRecordSchema = ServiceInfoSchema.pick({
  pid: true,
  protocol: true,
  version: true,
  startedAt: true,
}).extend({ socket: z.string().min(1) });
export type ServiceRecord = z.infer<typeof ServiceRecordSchema>;

/** The storage root's running service: one row of the global root's
 *  current values, read and changed under its write lock. */
export const TEXRA_SERVICE: ValueFamily<ServiceRecord, true> = {
  name: 'texra-service',
  schema: ServiceRecordSchema,
  deletable: true,
};

/** One top-level task in `tasks.list`. */
const TaskSummarySchema = z.object({
  /** The project folder the task works in: what the other procedures take. */
  workspace: z.string(),
  runId: RunIdSchema,
  label: z.string(),
  description: z.string().nullable(),
  statusKey: z.enum(RUN_STATUS_KEYS),
  /** Launch time, ms since the epoch: the list's order. */
  launchedAt: z.int().positive(),
  /** This service runs it now, so it answers approvals and streams text. */
  live: z.boolean(),
});
export type TaskSummary = z.infer<typeof TaskSummarySchema>;

/** Why `task.start` or `task.resume` did not reach its run. */
const TaskFailedSchema = z.object({
  _tag: z.literal('TaskFailed'),
  message: z.string(),
  /** The service already presented it, through the window attached to the
   *  project: the caller does not present it again. */
  presented: z.boolean().optional(),
});
export type TaskFailed = z.infer<typeof TaskFailedSchema>;

/** Why a task's records have no answer: the service holds no such run in
 *  the project, or its records would not read. */
const TaskRecordsFailedSchema = z.object({
  _tag: z.literal('TaskRecordsFailed'),
  reason: z.enum(['unknownRun', 'unreadable']),
  message: z.string(),
});
export type TaskRecordsFailed = z.infer<typeof TaskRecordsFailedSchema>;

/** Why the project's state has no answer: the service could not open the
 *  project, or its store refused the read or the write. */
const ProjectStateFailedSchema = z.object({
  _tag: z.literal('ProjectStateFailed'),
  message: z.string(),
});
export type ProjectStateFailed = z.infer<typeof ProjectStateFailedSchema>;

/** A state key's stored value: `value` absent when the key is unset. */
const StoredStateSchema = z.object({ value: JsonValueSchema.optional() });

/** The project a call addresses: its folder, as the client spells it. */
const workspace = Schema.String;

/** The procedures, in one group. */
export const TexraRpcs = RpcGroup.make(
  Rpc.make('service.hello', {
    payload: { protocol: Schema.Number },
    success: zodWire(ServiceInfoSchema),
  }),
  Rpc.make('service.stop', { payload: { drain: Schema.Boolean } }),
  Rpc.make('tasks.list', {
    /** `all`: every task, for resolving an id; otherwise the newest. */
    payload: { all: Schema.Boolean },
    success: zodWire(z.array(TaskSummarySchema)),
  }),
  Rpc.make('task.watch', {
    payload: { workspace, subscribe: zodWire(SubscribeSchema) },
    success: zodWire(EventsFrameSchema),
    error: zodWire(TaskFailedSchema),
    stream: true,
  }),
  Rpc.make('task.request', {
    payload: { workspace, request: zodWire(RuntimeRequestSchema) },
    success: zodWire(OutcomeSchema),
    error: zodWire(RequestErrorWireSchema),
  }),
  Rpc.make('task.start', {
    payload: {
      workspace,
      runId: zodWire(RunIdSchema),
      config: zodWire(AgentConfigSchema),
      /** The chat's previous root: its bypass settings carry over. */
      continues: zodWire(RunIdSchema.nullable()),
      /** Run on the configured helper model (the "fix LaTeX" actions). */
      preferHelperModel: Schema.Boolean,
      /** Replaces a quota-exhausted retry with the user's own API key. */
      ownApiKeyFallback: Schema.Boolean,
      /** An Auto-approve launch: the run starts with delegated work
       *  approved, as the run header's switch would set it. */
      approveDelegatedWork: Schema.Boolean,
      /** The policy the launch asked for: one stricter than the project's
       *  narrows this task only; a more permissive one is ignored. */
      approvalPolicy: zodWire(ApprovalPolicySchema.nullable()),
    },
    /** The run that started: the asked id, or the one the launch resolved. */
    success: zodWire(RunIdSchema),
    error: zodWire(TaskFailedSchema),
  }),
  Rpc.make('task.resume', {
    payload: { workspace, runId: zodWire(RunIdSchema) },
    /** The run that resumed: the asked one, or the parent that owns it;
     *  null when something it needs (its agent, a plugin) is missing, so it
     *  stays interrupted. */
    success: zodWire(RunIdSchema.nullable()),
    error: zodWire(TaskFailedSchema),
  }),
  /** What a task's current activation ends with, once it ends: its
   *  outcome, output, and the error a failed one ended with; and `at`,
   *  the service's fold position where it saw the end, so a window's
   *  fold at or past it shows the end (or the run's removal) too. */
  Rpc.make('task.ended', {
    payload: { workspace, runId: zodWire(RunIdSchema) },
    success: zodWire(
      RunEndSchema.pick({ outcome: true, output: true, error: true }).extend({
        at: CommitOrdinalSchema,
      }),
    ),
    error: zodWire(TaskFailedSchema),
  }),
  /** The run's saved setup; null when it saved none. */
  Rpc.make('task.config', {
    payload: { workspace, runId: zodWire(RunIdSchema) },
    success: zodWire(AgentConfigSchema.nullable()),
    error: zodWire(TaskRecordsFailedSchema),
  }),
  /** What the HTML transcript export reads: the run's display rows and its
   *  record (`assembleTrace`), or why it has none. */
  Rpc.make('task.exportTrace', {
    payload: { workspace, runId: zodWire(RunIdSchema) },
    success: zodWire(
      z.discriminatedUnion('status', [
        z.object({
          status: z.literal('ok'),
          // A `TraceDocument`: the run's display rows, in commit order.
          trace: z.object({
            runId: RunIdSchema,
            events: z.array(DisplaySessionEventSchema),
          }),
          record: RunRecordFieldsSchema,
        }),
        z.object({ status: z.enum(['config_missing', 'streamLogs_missing']) }),
      ]),
    ),
    error: zodWire(TaskRecordsFailedSchema),
  }),
  /** What the transcript export reads: the run's setup and the assembled
   *  input, each null when the run has none (`loadChatExportInput`). */
  Rpc.make('task.exportInput', {
    payload: { workspace, runId: zodWire(RunIdSchema) },
    success: zodWire(
      z.object({
        config: AgentConfigSchema.nullable(),
        exportInput: ChatExportInputSchema.nullable(),
      }),
    ),
    error: zodWire(TaskRecordsFailedSchema),
  }),
  Rpc.make('host.attach', {
    payload: {
      workspace,
      capabilities: zodWire(z.array(HostCapabilitySchema)),
    },
    success: zodWire(HostFrameSchema),
    error: zodWire(TaskFailedSchema),
    stream: true,
  }),
  /** A key of the project's state store, as it is stored now. */
  Rpc.make('state.get', {
    payload: { workspace, key: Schema.String },
    success: zodWire(StoredStateSchema),
    error: zodWire(ProjectStateFailedSchema),
  }),
  /** Store `next` under a key of the project's state store (an absent
   *  value clears it); with `ifCurrent`, only while the stored value is
   *  still that one. Answers whether it was written. */
  Rpc.make('state.set', {
    payload: {
      workspace,
      key: Schema.String,
      next: zodWire(StoredStateSchema),
      ifCurrent: zodWire(StoredStateSchema.nullable()),
    },
    success: Schema.Boolean,
    error: zodWire(ProjectStateFailedSchema),
  }),
  Rpc.make('host.focus', { payload: { attachment: Schema.String } }),
  Rpc.make('host.answer', {
    payload: { id: Schema.String, answer: zodWire(HostAnswerSchema) },
  }),
);
