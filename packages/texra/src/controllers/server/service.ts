/**
 * The service's procedures over the sessions it holds. Each handler answers
 * from the session of the project it names, opened on first use through
 * the service's {@link ServiceProjects}; a task it starts or resumes is a
 * run of that session, on its own fiber, so a client that disconnects never
 * stops it. The feed a client watches is the session bridge's framer over
 * that session, one port per watch, and a request is the session's one
 * request handler.
 */
import { randomUUID } from 'node:crypto';

import {
  Cause,
  Effect,
  Result,
  Schema,
  Scope,
  Stream,
  Struct,
  SubscriptionRef,
} from 'effect';
import type { RpcGroup } from 'effect/rpc';

import { type LocalSession, type Run } from '@texra-ai/worldline';
import {
  type RunId,
  toErrorMessage,
  Rejected,
} from '@texra-ai/worldline/schemas';
import { appSignalStream } from '@texra-ai/worldline/host';
import { frameSubscription } from '@texra/controllers/session/SessionFramer';
import { writeFileIfUnchanged } from '@texra/common/files/projectFileWrite';

import {
  BUILD_VERSION,
  PROTOCOL,
  ProjectStateFailed,
  RUN_RECORDS,
  TaskFailed,
  TaskRecordsFailed,
  TaskStarted,
  TexraRpcs,
  type RecordRpc,
  type ServiceInfo,
} from './protocol';

import { HostWindows } from './hostWindows';
import { listTasks } from './taskList';
import { Internal } from '@texra/shared/session/bridgeErrors';

/** What the service's projects carry: how many are open, and how many have
 *  a run at work (not one waiting for its next message). */
export interface ServiceLoad {
  readonly open: number;
  readonly working: number;
}

/** The projects the service serves: one session per folder, opened on
 *  demand and released once nothing has held it for a while (`serve`
 *  opens them). */
export interface ServiceProjects {
  /** The session of `workspace`, opened on first use and leased for the
   *  caller's scope: a leased session is never released. */
  readonly open: (
    workspace: string,
  ) => Effect.Effect<LocalSession, Error, Scope.Scope>;
  /** The sessions open now, by storage root. */
  readonly opened: Effect.Effect<ReadonlyMap<string, LocalSession>>;
  /** The load the projects carry now, as it changes. */
  readonly load: SubscriptionRef.SubscriptionRef<ServiceLoad>;
}

/** The service's own state, kept by the transport that serves it. */
export interface ServiceControl {
  readonly socket: string;
  readonly startedAt: number;
  /** Clients connected now. */
  readonly clients: Effect.Effect<number>;
  /** The service is leaving (a drain or a stop): no new task starts. */
  readonly draining: Effect.Effect<boolean>;
  /** Hold a task's start for the caller's scope, which a drain
   *  waits for; false, and nothing held, once the service is leaving. */
  readonly holdStart: Effect.Effect<boolean, never, Scope.Scope>;
  /** The watch streams open now: the service's socket closes once they
   *  have ended, so each carries its tasks' last rows. */
  readonly watching: SubscriptionRef.SubscriptionRef<number>;
  /** Stop now, or drain first; returns once the stop is asked. */
  readonly stop: (drain: boolean) => Effect.Effect<void>;
}

/** The runs of `session` at work: those its registry holds live that are
 *  not waiting for their next message. A started run is held before the
 *  view applies it, and counts. The one reading of "at work": a project's
 *  hold, the service's load and a drain's end all ask it. */
export const runsAtWork = (session: LocalSession): number => {
  const { runs } = session.view.current();
  return session
    .held()
    .filter(({ runId }) => runs.get(runId)?.position !== 'waiting').length;
};

/** The tasks the service runs now, across its open projects: every run
 *  its registries hold live, or with `atWork` only those at work
 *  ({@link runsAtWork}). */
export const runningTasks = Effect.fn('server.runningTasks')(function* (
  projects: ServiceProjects,
  atWork = false,
): Effect.fn.Return<number> {
  let running = 0;
  for (const session of (yield* projects.opened).values())
    running += atWork ? runsAtWork(session) : session.held().length;
  return running;
});

/** A handler that died answers `Internal` under a reference the service
 *  log carries the cause under, as the session bridge does. */
const internal = Effect.fn('handlers.internal')(function* (
  cause: Cause.Cause<unknown>,
) {
  const ref = randomUUID();
  yield* Effect.logError(`Service request ${ref} failed`, cause);
  return new Internal({ ref });
});

/**
 * What a start or a resume answers its client: the run it reached, or why
 * it reached none, which is the session's own failure, carried as the class
 * it is. A start that fails before its run opens has no row to show it: the
 * window that asked shows it. A client that disconnects once the session's
 * registry holds the run gives up only this answer: the run is its own
 * fiber's from then on, and a stop is how it ends. Before that (while the
 * session accepts the input, or a resume reads the runs above it) the work
 * is still this request's, so a disconnect there starts nothing and leaves
 * no row: the client that asked is gone, and nobody else was told of a run.
 */
const started = <E>(
  start: Effect.Effect<Run, E>,
): Effect.Effect<typeof TaskStarted.Type, E | TaskFailed> =>
  start.pipe(
    Effect.tapCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Effect.logWarning('A service task ended with a failure', cause),
    ),
    Effect.catchDefect((defect) =>
      Effect.fail(new TaskFailed({ message: toErrorMessage(defect) })),
    ),
    Effect.map((run) => ({ runId: run.runId, activation: run.activation })),
  );

/** The handlers of {@link TexraRpcs}, over the `projects` and the
 *  transport's `control`. */
export const serviceHandlers = (
  projects: ServiceProjects,
  control: ServiceControl,
) =>
  TexraRpcs.toLayer(
    Effect.gen(function* () {
      // The start is held until the handler's scope ends, by when the
      // run is the registry's: a drain waits for a start already under way.
      const refuseWhileDraining = Effect.gen(function* () {
        if (!(yield* control.holdStart))
          return yield* new TaskFailed({
            message: 'The service is shutting down; start the task again.',
          });
      });
      const hosts = yield* HostWindows;
      yield* Effect.forkScoped(
        // The files this process's sessions announce their tasks wrote.
        Stream.runForEach(
          appSignalStream('workspaceFilesWritten'),
          ({ absolutePaths }) => hosts.filesWritten(absolutePaths),
        ),
      );
      const open = (workspace: string) =>
        projects
          .open(workspace)
          .pipe(
            Effect.mapError(
              (error) => new TaskFailed({ message: error.message }),
            ),
          );
      /** A handler over the project's session: `read` answers it, and a
       *  failure is `failed`'s to word. */
      const over =
        <E>(failed: (message: string) => E) =>
        <A>(
          workspace: string,
          read: (session: LocalSession) => Effect.Effect<A, Error>,
        ): Effect.Effect<A, E> =>
          Effect.scoped(
            projects.open(workspace).pipe(
              Effect.flatMap(read),
              Effect.mapError((error) => failed(error.message)),
            ),
          );
      const session = over((message) => new TaskFailed({ message }));
      // cast: each member's handler answers that member of the project's
      // `Session.records(runId)`, which `RUN_RECORDS` types its procedure by.
      const records = Object.fromEntries(
        Struct.keys(RUN_RECORDS).map((member) => [
          `records.${member}`,
          ({ workspace, runId }: { workspace: string; runId: RunId }) =>
            over((message) => new TaskRecordsFailed({ runId, message }))(
              workspace,
              (held): Effect.Effect<unknown, Error> =>
                held.records(runId)[member],
            ),
        ]),
      ) as unknown as RpcGroup.HandlersFrom<RecordRpc>;
      return {
        'service.hello': Effect.fn('handlers.service.hello')(function* () {
          return {
            protocol: PROTOCOL.digest,
            version: BUILD_VERSION,
            pid: process.pid,
            socket: control.socket,
            startedAt: control.startedAt,
            clients: yield* control.clients,
            running: yield* runningTasks(projects),
            draining: yield* control.draining,
          } satisfies ServiceInfo;
        }),
        'service.stop': ({ drain }) => control.stop(drain),
        'tasks.list': Effect.fn('tasks.list')(function* ({ all }) {
          return yield* listTasks(all);
        }, Effect.orDie),
        'task.watch': ({ workspace, subscribe }) =>
          Stream.unwrap(
            Effect.gen(function* () {
              // Counted while it runs: the service's socket closes once every
              // watch has carried its tasks' last rows (`serve.ts`).
              yield* Effect.acquireRelease(
                SubscriptionRef.update(control.watching, (n) => n + 1),
                () => SubscriptionRef.update(control.watching, (n) => n - 1),
              );
              const session = yield* open(workspace);
              return frameSubscription(session.view, subscribe);
            }),
          ),
        'task.result': ({ workspace, runId, activation }) =>
          Effect.scoped(
            Effect.gen(function* () {
              const session = yield* open(workspace);
              const end = yield* session
                .run(runId, activation)
                .result.pipe(
                  Effect.mapError(
                    (error) => new TaskFailed({ message: error.message }),
                  ),
                );
              // The result arrives once the session's view shows the end.
              return { ...end, at: session.view.head() };
            }),
          ),
        'session.view': ({ workspace, runIds }) =>
          session(workspace, (held) => held.view.read(runIds)),
        'session.listRuns': ({ workspace }) =>
          session(workspace, (held) => held.listRuns),
        'session.deleteRuns': ({ workspace, target }) =>
          session(workspace, (held) => held.deleteRuns(target)),
        ...records,
        'task.request': ({ workspace, request }) =>
          Effect.scoped(
            projects.open(workspace).pipe(
              Effect.mapError(
                (error) => new Rejected({ reason: error.message }),
              ),
              Effect.flatMap((session) => session.request(request)),
              Effect.catchDefect((defect) =>
                internal(Cause.die(defect)).pipe(Effect.flatMap(Effect.fail)),
              ),
            ),
          ),
        'task.start': ({ workspace, start }) =>
          Effect.scoped(
            Effect.gen(function* () {
              yield* refuseWhileDraining;
              const session = yield* open(workspace);
              return yield* started(
                // A service task stays open for its windows' follow-ups.
                session.start({ ...start, interactive: true }),
              );
            }),
          ),
        'host.attach': ({ workspace, capabilities }) =>
          // The window's stream leases its project's session while it runs.
          Stream.unwrap(
            Effect.map(open(workspace), (session) =>
              hosts.attach(session, capabilities),
            ),
          ),
        // The project's state store, the service's own: a window opens none.
        'state.get': ({ workspace, keys }) =>
          Effect.scoped(
            Effect.flatMap(projects.open(workspace), (session) =>
              Effect.forEach(keys, (key) =>
                session.roots.workspaceState.get(key).pipe(
                  // The store answers what it holds, which is JSON.
                  Effect.flatMap((value) =>
                    value === undefined
                      ? Effect.succeed([key, {}] as const)
                      : Effect.map(
                          Schema.decodeUnknownEffect(Schema.Json)(value),
                          (json) => [key, { value: json }] as const,
                        ),
                  ),
                ),
              ),
            ).pipe(
              Effect.map((entries) => Object.fromEntries(entries)),
              Effect.mapError(
                (error) => new ProjectStateFailed({ message: error.message }),
              ),
            ),
          ),
        'state.set': ({ workspace, next, ifCurrent }) =>
          Effect.scoped(
            Effect.flatMap(projects.open(workspace), (session) => {
              const keys = Object.keys(next);
              // With `ifCurrent`, written only while the stored values are the
              // ones the window read: its read-modify-write, as one step here.
              return session.roots.workspaceState.modify(keys, (current) =>
                Result.succeed(
                  ifCurrent === null ||
                    keys.every(
                      (key) =>
                        JSON.stringify(current[key]) ===
                        JSON.stringify(ifCurrent[key]?.value),
                    )
                    ? ([
                        true,
                        Object.fromEntries(
                          keys.map((key) => [key, next[key]?.value]),
                        ),
                      ] as const)
                    : ([false] as const),
                ),
              );
            }).pipe(
              Effect.mapError(
                (error) => new ProjectStateFailed({ message: error.message }),
              ),
            ),
          ),
        'file.write': ({ path, contents, expected }) =>
          writeFileIfUnchanged(path, contents, expected),
        'host.focus': ({ attachment }) => hosts.focus(attachment),
        'host.answer': ({ attachment, message }) =>
          hosts.answer(attachment, message),
        'task.resume': ({ workspace, runId, apiKeys }) =>
          Effect.scoped(
            Effect.gen(function* () {
              yield* refuseWhileDraining;
              const session = yield* open(workspace);
              // A run this service is running is answered as it runs: the
              // client takes up the conversation it belongs to (a chat left
              // it waiting here), which the session names.
              return yield* started(
                session.resume(runId, { interactive: true, apiKeys }),
              );
            }),
          ),
      };
    }),
  );
