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
 * - `task.start` / `task.resume`: launch or continue a task in the service.
 * - `project.policy`: the approval policy of a project's session.
 */
import { Effect, Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/rpc';
import * as SchemaIssue from 'effect/SchemaIssue';
import { z } from 'zod';

import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { TexraApprovalPolicySchema } from '@shared/approvalPolicy';
import { RunIdSchema } from '@shared/schemas';
import {
  OutcomeSchema,
  RuntimeRequestSchema,
} from '@shared/session/runtimeRequest';
import {
  EventsFrameSchema,
  RequestErrorWireSchema,
  SubscribeSchema,
} from '@shared/session/sessionFrames';

/** Bumped whenever a procedure or a payload changes shape. A client newer
 *  than the running service retires it; an older one stays in process. */
export const PROTOCOL_VERSION = 1;

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
        ? Effect.succeed(parsed.data)
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
    },
    /** The run that started: the asked id, or the one the launch resolved. */
    success: zodWire(RunIdSchema),
    error: zodWire(TaskFailedSchema),
  }),
  Rpc.make('task.resume', {
    payload: { workspace, runId: zodWire(RunIdSchema) },
    /** The run that resumed: the asked one, or the parent that owns it. */
    success: zodWire(RunIdSchema),
    error: zodWire(TaskFailedSchema),
  }),
  Rpc.make('project.policy', {
    payload: { workspace, policy: zodWire(TexraApprovalPolicySchema) },
    error: zodWire(TaskFailedSchema),
  }),
);
