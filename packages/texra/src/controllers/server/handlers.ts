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
  Duration,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  Option,
  Result,
  Schedule,
  Scope,
  Stream,
  SubscriptionRef,
} from 'effect';

import {
  Internal,
  type LocalSession,
  Rejected,
  type Run,
  type Session,
  type RunEnd,
} from '@texra-ai/harness';
import { presentRunFailure } from '@texra-ai/harness/host';
import {
  type SessionView,
  isLiveRun,
  emptyRunEndOutput,
  RUN_OUTCOME,
  RUN_PHASE,
  type JsonValue,
  type RunId,
  toErrorMessage,
} from '@texra-ai/harness/schemas';
import { appSignalStream } from '@texra-ai/harness/host';
import { loadChatExportInput } from '@texra/agent/export/loadChatExportInput';
import type { HostSnapshot } from '@texra/shared/session/hostSnapshot';
import { frameSubscription } from '@texra/controllers/session/SessionFramer';
import type { EditorHostShape } from '@texra/tools/editorHost';

import {
  PROTOCOL_VERSION,
  ProjectStateFailed,
  TaskFailed,
  TaskRecordsFailed,
  TexraRpcs,
  type ServiceInfo,
} from './protocol';

import { makeHostWindows } from './hostWindows';
import { listTasks } from './taskList';
import type { CommitOrdinal } from '@texra-ai/harness/transcript';

/** A project the service serves: its session, as every host drives it. */
export interface ServiceProject {
  readonly session: LocalSession;
}

/** The projects the service serves: one session per folder, opened on
 *  demand and closed once idle. The host that composes the service builds
 *  each project's roots, so this is its port. */
export class ServiceProjects extends Context.Service<
  ServiceProjects,
  {
    /** The storage root every project's store sits under. */
    readonly storageRoot: string;
    /** The editor registry the service's plugins read (`texraPlugins`):
     *  each presented project's windows attach their editors to it. */
    readonly editors: EditorHostShape;
    /** The session of `workspace`, opened on first use and leased for the
     *  caller's scope: a leased session is never closed for idleness. */
    readonly open: (
      workspace: string,
    ) => Effect.Effect<ServiceProject, Error, Scope.Scope>;
    /** The sessions open now, by storage root. */
    readonly opened: Effect.Effect<ReadonlyMap<string, LocalSession>>;
    /** Close, with their stores, the sessions no lease and no run has held
     *  for `idleFor`; answers the sessions closed. */
    readonly closeIdle: (
      idleFor: Duration.Duration,
    ) => Effect.Effect<readonly Session[]>;
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
    /** A drain is in progress: no new task starts. */
    readonly draining: Effect.Effect<boolean>;
    /** Hold a task's admission for the caller's scope, which a drain
     *  waits for; false, and nothing held, once the service is leaving. */
    readonly admission: Effect.Effect<boolean, never, Scope.Scope>;
    /** Stop now, or drain first; returns once the stop is asked. */
    readonly stop: (drain: boolean) => Effect.Effect<void>;
    /** How long anything unused is kept: the service with no client and
     *  no task, and a project's session with no lease and no run held. */
    readonly idleAfter: Duration.Duration;
  }
>()('@texra/server/ServiceControl') {}

/** The tasks the service runs now, across its open projects: what its
 *  registry holds live, which an admitted run is before the view folds it.
 *  With `parked` false, only those at work, not a conversation the view
 *  shows waiting for its next message. */
export const runningTasks = Effect.fn('server.runningTasks')(function* (
  projects: Context.Service.Shape<typeof ServiceProjects>,
  parked = true,
): Effect.fn.Return<number> {
  let running = 0;
  for (const session of (yield* projects.opened).values()) {
    const { runs } = session.view.current();
    for (const { runId, live } of session.held())
      if (live && (parked || runs.get(runId)?.status !== RUN_PHASE.WAITING))
        running += 1;
  }
  return running;
});

/** The live run `runId` continues in: itself, or the live run its parent
 *  chain reaches; null when `runId` is not live here. Live is what this
 *  process runs (`held`), not the claim the view shows (the view's
 *  `ownedHere`, which a fork's rows also take). */
function liveRoot(session: LocalSession, runId: RunId): RunId | null {
  const view: SessionView = session.view.current();
  const live = (id: RunId) => session.held(id)?.live === true;
  if (!live(runId)) return null;
  let root = runId;
  for (
    let parent = view.runs.get(root)?.parentId;
    parent != null && live(parent);
    parent = view.runs.get(root)?.parentId
  )
    root = parent;
  return root;
}

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
 * What `runId` ends with in `session`: once every owner of the run here has
 * left, its `run.end` as the run's records hold it, and `at`, the cursor of
 * the first level that shows the run no longer live, or gone: a fold at or
 * past it holds the run's end, or its removal. A run that ended with no
 * `run.end` (deleted) ends with the outcome its view shows, without output;
 * a store that cannot be read fails the answer, never reads as an empty end.
 */
function runEnded(
  { session }: ServiceProject,
  runId: RunId,
): Effect.Effect<
  Pick<RunEnd, 'outcome' | 'output' | 'error'> & { at: CommitOrdinal },
  TaskFailed
> {
  return Effect.gen(function* () {
    yield* session.held(runId)?.drained ?? Effect.void;
    const ended = Option.getOrUndefined(
      yield* session.view.changes.pipe(
        Stream.filter((view) => {
          const run = view.runs.get(runId);
          return run === undefined || !isLiveRun(run);
        }),
        Stream.runHead,
      ),
    );
    const run = ended?.runs.get(runId);
    const at = ended?.cursor ?? session.view.current().cursor;
    const end = yield* session
      .records(runId)
      .readRunEnd()
      .pipe(
        Effect.mapError(
          (error) =>
            new TaskFailed({
              message: `Task ${runId} ended; its result could not be read: ${error.message}`,
            }),
        ),
      );
    if (end !== null) {
      const { outcome, output, error } = end;
      return { outcome, output, at, ...(error !== undefined && { error }) };
    }
    return {
      outcome: run?.durableOutcome ?? RUN_OUTCOME.CANCELLED,
      output: emptyRunEndOutput(),
      at,
    };
  });
}

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
    const scope = yield* Effect.scope;
    // The admission is held until the handler's scope ends, by when the
    // run is the registry's: a drain waits for a start already under way.
    const refuseWhileDraining = Effect.gen(function* () {
      if (!(yield* control.admission))
        return yield* Effect.fail(
          new TaskFailed({
            message: 'The service is shutting down; start the task again.',
          }),
        );
    });
    const hosts = yield* makeHostWindows;
    yield* Effect.forkScoped(
      // The files this process's sessions announce their tasks wrote.
      Stream.runForEach(
        appSignalStream('workspaceFilesWritten'),
        ({ absolutePaths }) => hosts.filesWritten(absolutePaths),
      ),
    );
    /** Each session's presentation surface, given once (claimed in one
     *  step) and closed with the session: what its runs ask of a host goes
     *  to the project's windows. Keyed by the session itself: a project
     *  reopened after an idle close is a new session, given its own. */
    const presented = new Map<Session, Scope.Closeable>();
    const present = (session: Session): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (presented.has(session)) return Effect.void;
        const surface = Scope.forkUnsafe(scope);
        presented.set(session, surface);
        return hosts
          .adopt(session, projects.editors)
          .pipe(Scope.provide(surface));
      });
    // A session no client leases and no run holds closes once idle long
    // enough, with its surface: a service that lives for weeks keeps only
    // the projects in use.
    const idleMs = Duration.toMillis(control.idleAfter);
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        for (const session of yield* projects.closeIdle(control.idleAfter)) {
          yield* Effect.logInfo(
            `Closed the idle session of ${session.roots.storage}`,
          );
          const surface = presented.get(session);
          presented.delete(session);
          if (surface !== undefined) yield* Scope.close(surface, Exit.void);
        }
      }).pipe(
        Effect.repeat(
          Schedule.spaced(Duration.millis(Math.min(60_000, idleMs / 2))),
        ),
      ),
    );
    const openSession = (workspace: string) =>
      projects
        .open(workspace)
        .pipe(Effect.tap((project) => present(project.session)));
    const open = (workspace: string) =>
      openSession(workspace).pipe(
        Effect.mapError((error) => new TaskFailed({ message: error.message })),
      );
    /** What `read` answers from `runId`'s records in the project's session,
     *  read where the run is held; a run the session does not hold is
     *  unknown, not a run without records. */
    const records = <A>(
      workspace: string,
      runId: RunId,
      read: (session: LocalSession) => Effect.Effect<A, Error>,
    ): Effect.Effect<A, TaskRecordsFailed> =>
      Effect.scoped(
        openSession(workspace).pipe(
          Effect.mapError(
            (error) =>
              new TaskRecordsFailed({
                runId,
                reason: 'unreadable',
                message: error.message,
              }),
          ),
          // Whether the run exists, from the log rather than the live
          // fold: a session the open just (re)built has folded nothing yet.
          Effect.flatMap(({ session }) =>
            Effect.flatMap(session.view.read([runId]), (level) =>
              level.runs.has(runId)
                ? read(session).pipe(
                    Effect.mapError(
                      (error) =>
                        new TaskRecordsFailed({
                          runId,
                          reason: 'unreadable',
                          message: error.message,
                        }),
                    ),
                  )
                : Effect.fail(
                    new TaskRecordsFailed({
                      runId,
                      reason: 'unknownRun',
                      message: `The TeXRA service holds no task ${runId} in ${workspace}.`,
                    }),
                  ),
            ),
          ),
        ),
      );
    return {
      'service.hello': Effect.fn('handlers.service.hello')(function* () {
        return {
          protocol: PROTOCOL_VERSION,
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
      'tasks.list': ({ all }) =>
        Effect.gen(function* () {
          return yield* listTasks(
            projects.storageRoot,
            yield* projects.opened,
            all,
          );
        }).pipe(Effect.orDie),
      'task.watch': ({ workspace, subscribe }) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const { session } = yield* open(workspace);
            // The client renders its own host state; the service has none.
            const host = yield* SubscriptionRef.make<HostSnapshot | null>(null);
            const key = session.roots.storage;
            return frameSubscription({ key, view: session.view }, host, {
              ...subscribe,
              session: key,
            });
          }),
        ),
      'task.ended': ({ workspace, runId }) =>
        Effect.scoped(
          Effect.flatMap(open(workspace), (project) =>
            runEnded(project, runId),
          ),
        ),
      'task.config': ({ workspace, runId }) =>
        records(workspace, runId, (session) =>
          session.records(runId).readConfig(),
        ),
      'task.exportInput': ({ workspace, runId }) =>
        records(workspace, runId, (session) =>
          Effect.map(
            loadChatExportInput(runId, session),
            ({ config, exportInput }) => ({ config, exportInput }),
          ),
        ),
      'task.exportTrace': ({ workspace, runId }) =>
        records(workspace, runId, (session) =>
          session.records(runId).readTrace(),
        ),
      'task.request': ({ workspace, request }) =>
        Effect.scoped(
          openSession(workspace).pipe(
            Effect.mapError((error) => new Rejected({ reason: error.message })),
            Effect.flatMap(({ session }) => session.request(request)),
            Effect.catchDefect((defect) =>
              internal(Cause.die(defect)).pipe(Effect.flatMap(Effect.fail)),
            ),
          ),
        ),
      'task.start': ({
        workspace,
        runId,
        config,
        continues,
        preferHelperModel,
        approveDelegatedWork,
        approvalPolicy,
      }) =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* refuseWhileDraining;
            const { session } = yield* open(workspace);
            const run: Run = yield* admit(
              runs,
              session.start({
                config,
                runId,
                ...(continues !== null && { continues }),
                helperModel: preferHelperModel,
                approval: {
                  delegated: approveDelegatedWork,
                  ...(approvalPolicy !== null && { policy: approvalPolicy }),
                },
                interactive: true,
              }),
              // A start fails before its run opens, with no row to show
              // it: the project's windows are told here, once, and the
              // client hears that they were.
              (error) =>
                presentRunFailure(session, error).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new TaskFailed({
                        message: error.message,
                        presented: true,
                      }),
                    ),
                  ),
                ),
            );
            return run.runId;
          }),
        ),
      'host.attach': ({ workspace, capabilities }) =>
        // The window's stream leases its project's session while it runs.
        Stream.unwrap(
          Effect.map(
            projects
              .open(workspace)
              .pipe(
                Effect.mapError(
                  (error) => new TaskFailed({ message: error.message }),
                ),
              ),
            ({ session }) =>
              hosts.attach(session, capabilities).pipe(
                // The session's surface is given once the window is held,
                // so a first attach is never told that no window is.
                Stream.tap((frame) =>
                  frame.kind === 'attached' ? present(session) : Effect.void,
                ),
              ),
          ),
        ),
      // The project's state store, the service's own: a window opens none.
      'state.get': ({ workspace, key }) =>
        Effect.scoped(
          Effect.flatMap(projects.open(workspace), ({ session }) =>
            session.roots.workspaceState.get(key),
          ).pipe(
            // The store answers what it holds, which is JSON.
            Effect.map((value) => ({
              ...(value !== undefined && { value: value as JsonValue }),
            })),
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
      'task.resume': ({ workspace, runId }) =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* refuseWhileDraining;
            const { session } = yield* open(workspace);
            // A run this service is running needs no resume: the client that
            // asks takes up the conversation it belongs to, where it is (a
            // chat left it waiting here).
            const live = liveRoot(session, runId);
            if (live !== null) return live;
            return yield* admit(
              runs,
              session.resume(runId, { interactive: true }).pipe(
                Effect.map((run): RunId | null => run.runId),
                // Blocked, not failed: it stays interrupted until what it
                // needs is back.
                Effect.catchTag('ResumeRefused', (refusal) =>
                  refusal.reason === 'blocked'
                    ? Effect.succeed(null)
                    : Effect.fail(refusal),
                ),
              ),
              (error) =>
                Effect.fail(new TaskFailed({ message: error.message })),
            );
          }),
        ),
    };
  }),
);
