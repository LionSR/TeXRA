/**
 * The service's procedures over the sessions it holds. Each handler answers
 * from the session of the project it names, opened on first use through
 * {@link ServiceProjects}; a task it starts or resumes runs in the service's
 * own fiber set, so a client that disconnects never stops it. The feed a
 * client watches is the session bridge's framer over that session, one port
 * per watch, and a request is the session's one request handler.
 */
import { randomUUID } from 'node:crypto';

import {
  Cause,
  Context,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  Option,
  Result,
  Schema,
  Scope,
  Stream,
  Struct,
  SubscriptionRef,
} from 'effect';
import type { RpcGroup } from 'effect/rpc';

import { LaunchRefused, type LocalSession } from '@texra-ai/harness';
import {
  type RunId,
  toErrorMessage,
  Rejected,
} from '@texra-ai/harness/schemas';
import { appSignalStream } from '@texra-ai/harness/host';
import { frameSubscription } from '@texra/controllers/session/SessionFramer';

import {
  PROTOCOL,
  ProjectStateFailed,
  RUN_RECORDS,
  TaskFailed,
  TaskRecordsFailed,
  TexraRpcs,
  type RecordRpc,
  type ServiceInfo,
} from './protocol';

import { HostWindows } from './hostWindows';
import { listTasks } from './taskList';
import { Internal } from '@texra/shared/session/bridgeErrors';

/** A project the service serves: its session, as every host drives it. */
export interface ServiceProject {
  readonly session: LocalSession;
}

/** What the service's projects carry: how many are open, and how many have
 *  a run at work (not one waiting for its next message). */
export interface ServiceLoad {
  readonly open: number;
  readonly working: number;
}

/** The projects the service serves: one session per folder, opened on
 *  demand and released once nothing has held it for a while. The host that
 *  composes the service builds each project's roots, so this is its port. */
export class ServiceProjects extends Context.Service<
  ServiceProjects,
  {
    /** The storage root every project's store sits under. */
    readonly storageRoot: string;
    /** The session of `workspace`, opened on first use and leased for the
     *  caller's scope: a leased session is never released. */
    readonly open: (
      workspace: string,
    ) => Effect.Effect<ServiceProject, Error, Scope.Scope>;
    /** The sessions open now, by storage root. */
    readonly opened: Effect.Effect<ReadonlyMap<string, LocalSession>>;
    /** The load the projects carry now, as it changes. */
    readonly load: SubscriptionRef.SubscriptionRef<ServiceLoad>;
  }
>()('@texra-ai/texra/server/ServiceProjects') {}

/** The service's own state, kept by the transport that serves it. */
export class ServiceControl extends Context.Service<
  ServiceControl,
  {
    readonly version: string;
    readonly socket: string;
    readonly startedAt: number;
    /** Clients connected now. */
    readonly clients: Effect.Effect<number>;
    /** The service is leaving (a drain or a stop): no new task starts. */
    readonly draining: Effect.Effect<boolean>;
    /** Hold a task's admission for the caller's scope, which a drain
     *  waits for; false, and nothing held, once the service is leaving. */
    readonly admission: Effect.Effect<boolean, never, Scope.Scope>;
    /** The watch streams open now: the service's socket closes once they
     *  have ended, so each carries its tasks' last rows. */
    readonly watching: SubscriptionRef.SubscriptionRef<number>;
    /** Stop now, or drain first; returns once the stop is asked. */
    readonly stop: (drain: boolean) => Effect.Effect<void>;
  }
>()('@texra-ai/texra/server/ServiceControl') {}

/** The tasks the service runs now, across its open projects: what its
 *  registry holds live, which a started run is before the view applies
 *  it. `atWork`: only those not waiting for their next message, a run the
 *  view does not show yet counted as at work. */
export const runningTasks = Effect.fn('server.runningTasks')(function* (
  projects: Context.Service.Shape<typeof ServiceProjects>,
  atWork = false,
): Effect.fn.Return<number> {
  let running = 0;
  for (const session of (yield* projects.opened).values()) {
    const { runs } = session.view.current();
    for (const { runId } of session.held())
      if (!atWork || runs.get(runId)?.position !== 'waiting') running += 1;
  }
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
 * Run `start` (a start or a resume) in the service's fiber set, so a
 * client that disconnects never aborts it, and answer once its run has
 * started. A start that fails before its run opens has no row to show it:
 * the window that asked shows it. The service stopping first is no failure
 * of the task's.
 */
function startDetached<A, E extends { readonly message: string }>(
  runs: FiberSet.FiberSet,
  start: Effect.Effect<A, E>,
): Effect.Effect<A, TaskFailed | LaunchRefused> {
  return FiberSet.run(runs, start).pipe(
    Effect.flatMap(Fiber.await),
    Effect.flatMap(
      Exit.match({
        onSuccess: Effect.succeed,
        onFailure: (cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.fail(
                new TaskFailed({
                  message: 'The service stopped before the task started.',
                }),
              )
            : Effect.logWarning(
                'A service task ended with a failure',
                cause,
              ).pipe(
                Effect.andThen(
                  Option.match(Cause.findErrorOption(cause), {
                    // A refused launch is carried as itself, for the
                    // window that asked to show with its notice.
                    onSome: (error) =>
                      Effect.fail(
                        error instanceof LaunchRefused
                          ? error
                          : new TaskFailed({ message: error.message }),
                      ),
                    onNone: () =>
                      Effect.fail(
                        new TaskFailed({
                          message: toErrorMessage(cause),
                        }),
                      ),
                  }),
                ),
              ),
      }),
    ),
  );
}

/** The handlers of {@link TexraRpcs}, over the two ports above. */
export const serviceHandlers = TexraRpcs.toLayer(
  Effect.gen(function* () {
    const projects = yield* ServiceProjects;
    const control = yield* ServiceControl;
    // A task's start and resume are its session's, as every host's are.
    const runs = yield* FiberSet.make();
    // The admission is held until the handler's scope ends, by when the
    // run is the registry's: a drain waits for a start already under way.
    const refuseWhileDraining = Effect.gen(function* () {
      if (!(yield* control.admission))
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
            Effect.flatMap(({ session }) => read(session)),
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
          version: control.version,
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
            const { session } = yield* open(workspace);
            // The frames name the session as the service keys it.
            const key = session.roots.storage;
            return frameSubscription(
              { key, view: session.view },
              { ...subscribe, session: key },
            );
          }),
        ),
      'task.result': ({ workspace, runId, activation }) =>
        Effect.scoped(
          Effect.gen(function* () {
            const { session } = yield* open(workspace);
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
            Effect.mapError((error) => new Rejected({ reason: error.message })),
            Effect.flatMap(({ session }) => session.request(request)),
            Effect.catchDefect((defect) =>
              internal(Cause.die(defect)).pipe(Effect.flatMap(Effect.fail)),
            ),
          ),
        ),
      'task.start': ({ workspace, start }) =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* refuseWhileDraining;
            const { session } = yield* open(workspace);
            const run = yield* startDetached(
              runs,
              // A service task stays open for its windows' follow-ups.
              session.start({ ...start, interactive: true }),
            );
            return { runId: run.runId, activation: run.activation };
          }),
        ),
      'host.attach': ({ workspace, capabilities }) =>
        // The window's stream leases its project's session while it runs.
        Stream.unwrap(
          Effect.map(open(workspace), ({ session }) =>
            hosts.attach(session, capabilities),
          ),
        ),
      // The project's state store, the service's own: a window opens none.
      'state.get': ({ workspace, key }) =>
        Effect.scoped(
          Effect.flatMap(projects.open(workspace), ({ session }) =>
            session.roots.workspaceState.get(key),
          ).pipe(
            // The store answers what it holds, which is JSON.
            Effect.flatMap((value) =>
              value === undefined
                ? Effect.succeed({})
                : Effect.map(
                    Schema.decodeUnknownEffect(Schema.Json)(value),
                    (json) => ({ value: json }),
                  ),
            ),
            Effect.mapError(
              (error) => new ProjectStateFailed({ message: error.message }),
            ),
          ),
        ),
      'state.set': ({ workspace, key, next, ifCurrent }) =>
        Effect.scoped(
          Effect.flatMap(projects.open(workspace), ({ session }) => {
            const state = session.roots.workspaceState;
            if (ifCurrent === null)
              return Effect.as(state.update(key, next.value), true);
            // Written only while the stored value is the one the window
            // read: the window's read-modify-write, as one step here.
            const expected = JSON.stringify(ifCurrent.value);
            return state
              .modify(key, (current) =>
                JSON.stringify(current) === expected
                  ? Result.succeed(next.value)
                  : Result.fail('changed' as const),
              )
              .pipe(
                Effect.as(true),
                Effect.catchIf(
                  (error) => error === 'changed',
                  () => Effect.succeed(false),
                ),
              );
          }).pipe(
            Effect.mapError(
              (error) => new ProjectStateFailed({ message: error.message }),
            ),
          ),
        ),
      'host.focus': ({ attachment }) => hosts.focus(attachment),
      'host.answer': ({ id, answer }) => hosts.answer(id, answer),
      'task.resume': ({ workspace, runId, apiKeys }) =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* refuseWhileDraining;
            const { session } = yield* open(workspace);
            // A run this service is running is answered as it runs: the
            // client takes up the conversation it belongs to (a chat left
            // it waiting here), which the session names.
            const run = yield* startDetached(
              runs,
              session.resume(runId, { interactive: true, apiKeys }),
            );
            return { runId: run.runId, activation: run.activation };
          }),
        ),
    };
  }),
);
