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
  SubscriptionRef,
} from 'effect';

import {
  Internal,
  type LocalSession,
  Rejected,
  type RunRecords,
} from '@texra-ai/harness';
import { launchNoticeOf } from '@texra-ai/harness/host';
import {
  type RunId,
  RUN_PHASE,
  toErrorMessage,
} from '@texra-ai/harness/schemas';
import { appSignalStream } from '@texra-ai/harness/host';
import { frameSubscription } from '@texra/controllers/session/SessionFramer';

import {
  PROTOCOL,
  ProjectStateFailed,
  TaskFailed,
  TaskRecordsFailed,
  TexraRpcs,
  type ServiceInfo,
} from './protocol';

import { HostWindows } from './hostWindows';
import { listTasks } from './taskList';

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
>()('@texra/server/ServiceProjects') {}

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
>()('@texra/server/ServiceControl') {}

/** The tasks the service runs now, across its open projects: what its
 *  registry holds live, which an admitted run is before the view applies
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
      if (!atWork || runs.get(runId)?.status !== RUN_PHASE.WAITING)
        running += 1;
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
 * Run `admission` (a start or a resume) in the service's fiber set, so a
 * client that disconnects never aborts it, and answer once its run is
 * admitted. A failure is `refused`'s to word; the service stopping first
 * is no failure of the task's.
 */
function admit<A, E>(
  runs: FiberSet.FiberSet,
  admission: Effect.Effect<A, E>,
  refused: (error: E) => Effect.Effect<never, TaskFailed>,
): Effect.Effect<A, TaskFailed> {
  return FiberSet.run(runs, admission).pipe(
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
                    onSome: refused,
                    onNone: () =>
                      Effect.fail(
                        new TaskFailed({
                          message: toErrorMessage(Cause.squash(cause)),
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
    /** One member of `Session.records(runId)` over the project's session. */
    const record =
      <A>(read: (records: RunRecords) => Effect.Effect<A, Error>) =>
      ({ workspace, runId }: { workspace: string; runId: RunId }) =>
        over((message) => new TaskRecordsFailed({ runId, message }))(
          workspace,
          (held) => read(held.records(runId)),
        );
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
        return yield* listTasks(
          projects.storageRoot,
          yield* projects.opened,
          all,
        );
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
        session(workspace, (held) => held.listRuns()),
      'session.deleteRuns': ({ workspace, target }) =>
        session(workspace, (held) => held.deleteRuns(target)),
      'records.exists': record((records) => records.exists()),
      'records.config': record((records) => records.readConfig()),
      'records.report': record((records) => records.readReport()),
      'records.runEnd': record((records) => records.readRunEnd()),
      'records.result': record((records) => records.readResult()),
      'records.workspaceFiles': record((records) =>
        records.readWorkspaceFiles(),
      ),
      'records.skills': record((records) => records.readSkills()),
      'records.resumable': record((records) => records.readResumable()),
      'records.rejection': record((records) => records.readRejection()),
      'records.conversation': record((records) => records.readConversation()),
      'records.trace': record((records) => records.readTrace()),
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
            const run = yield* admit(
              runs,
              // A service task stays open for its windows' follow-ups.
              session.start({ ...start, interactive: true }),
              // A start that fails before its run opens has no row to show
              // it: the window that asked shows it, with its notice.
              (error) =>
                Effect.fail(
                  new TaskFailed({
                    message: error.message,
                    notice: launchNoticeOf(error),
                  }),
                ),
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
            const run = yield* admit(
              runs,
              session.resume(runId, { interactive: true, apiKeys }),
              (error) =>
                Effect.fail(
                  new TaskFailed({
                    message: error.message,
                    notice: launchNoticeOf(error),
                  }),
                ),
            );
            return { runId: run.runId, activation: run.activation };
          }),
        ),
    };
  }),
);
