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
 * decode is the Zod parse, so Zod stays the single source of truth (ruling
 * D3). The procedures:
 *
 * - `service.hello`: the handshake; a client compares `protocol` with its own.
 * - `service.stop`: stop now (`drain: false`), or stop taking new work and
 *   exit once the running tasks end (`drain: true`, the upgrade path).
 * - `tasks.list`: every task in every project this storage root holds.
 * - `task.watch`: a project's session feed (a stream of `EventsFrame`s)
 *   for one `Subscribe`, the frames the webview bridge already carries.
 * - `task.request`: one `RuntimeRequest` (send, approve, stop, fork, …).
 * - `task.start` / `task.resume`: launch or continue a task in the service;
 *   `task.ended`: the outcome it ends with.
 * - `task.model`: switch a running task's model.
 * - `project.policy`: the approval policy of a project's session.
 * - `host.attach` / `host.focus` / `host.answer`: a window offering its host
 *   capabilities to its project's tasks (see `hostCalls.ts`).
 * - `request.preview`: a pending tool edit's original and proposed content,
 *   which the durable request does not carry.
 */
import { Effect, Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/rpc';
import * as SchemaIssue from 'effect/SchemaIssue';
import { z } from 'zod';

import { AgentConfigSchema } from '@texra-ai/harness/schemas';
import { TexraApprovalPolicySchema } from '@shared/approvalPolicy';
import { RunEndSchema, RunIdSchema } from '@shared/schemas';

import {
  OutcomeSchema,
  RuntimeRequestSchema,
} from '@shared/session/runtimeRequest';
import {
  EventsFrameSchema,
  RequestErrorWireSchema,
  SubscribeSchema,
} from '@shared/session/sessionFrames';
import {
  HostAnswerSchema,
  HostCapabilitySchema,
  HostFrameSchema,
} from './hostCalls';

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
export const PROTOCOL_VERSION = 11;

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

/** One top-level task in `tasks.list`. */
const TaskSummarySchema = z.object({
  /** The project folder the task works in: what the other procedures take. */
  workspace: z.string(),
  runId: RunIdSchema,
  label: z.string(),
  description: z.string().nullable(),
  statusLabel: z.string(),
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
});
export type TaskFailed = z.infer<typeof TaskFailedSchema>;

/** What a pending tool edit would change: the preview a window shows
 *  beside the request's path and line counts. */
const ToolEditPreviewSchema = z.object({
  originalContent: z.string(),
  proposedContent: z.string(),
});
export type ToolEditPreview = z.infer<typeof ToolEditPreviewSchema>;

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
    },
    /** The run that started: the asked id, or the one the launch resolved. */
    success: zodWire(RunIdSchema),
    error: zodWire(TaskFailedSchema),
  }),
  Rpc.make('task.resume', {
    payload: { workspace, runId: zodWire(RunIdSchema) },
    /** The run that resumed: the asked one, or the parent that owns it,
     *  and whether it is a workflow, which settles with its whole run (what
     *  `task.ended` answers); null when something it needs (its agent, a
     *  plugin) is missing, so it stays interrupted. */
    success: zodWire(
      z.object({ runId: RunIdSchema, workflow: z.boolean() }).nullable(),
    ),
    error: zodWire(TaskFailedSchema),
  }),
  /** What a task's current activation ends with, once it ends: its
   *  outcome and output. */
  Rpc.make('task.ended', {
    payload: { workspace, runId: zodWire(RunIdSchema) },
    success: zodWire(RunEndSchema.pick({ outcome: true, output: true })),
    error: zodWire(TaskFailedSchema),
  }),
  Rpc.make('request.preview', {
    payload: { workspace, requestId: Schema.String },
    /** Null once the request is settled, or when the service staged none. */
    success: zodWire(ToolEditPreviewSchema.nullable()),
    error: zodWire(TaskFailedSchema),
  }),
  /** Switch a run the service is running to `model` from its next turn;
   *  refused with the run's reason. */
  Rpc.make('task.model', {
    payload: { workspace, runId: zodWire(RunIdSchema), model: Schema.String },
    error: zodWire(TaskFailedSchema),
  }),
  Rpc.make('project.policy', {
    payload: { workspace, policy: zodWire(TexraApprovalPolicySchema) },
    error: zodWire(TaskFailedSchema),
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
  Rpc.make('host.focus', { payload: { attachment: Schema.String } }),
  Rpc.make('host.answer', {
    payload: { id: Schema.String, answer: zodWire(HostAnswerSchema) },
  }),
);
