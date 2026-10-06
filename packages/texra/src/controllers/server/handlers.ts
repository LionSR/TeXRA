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
  Deferred,
  Effect,
  FiberSet,
  Scope,
  Stream,
  SubscriptionRef,
} from 'effect';

import { Internal, type RequestError } from '@texra-ai/harness';
import { describeFollowUpFailure } from '@agent/followUp/ToolUseFollowUp';
import { resumeRun } from '@agent/runtime/resumeRun';
import { runAgent } from '@agent/runtime/runAgent';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { getRunRecords } from '@agent/storage';
import { isDocumentTaskConfig, RUN_PHASE, type RunId } from '@shared/schemas';
import type { HostSnapshot } from '@shared/session/hostSnapshot';
import {
  RequestErrorWireSchema,
  type RequestErrorWire,
} from '@shared/session/sessionFrames';
import { isLiveRun, type SessionView } from '@shared/session/sessionView';
import { frameSubscription } from '@texra/controllers/session/SessionFramer';
import { runEnded } from '@texra/controllers/session/sessionBackend';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

import {
  PROTOCOL_VERSION,
  TexraRpcs,
  type ServiceInfo,
  type TaskFailed,
} from './protocol';
import { makeHostWindows } from './hostWindows';
import { listTasks } from './taskList';
import type { ProcessServices } from '@texra-ai/harness';

/** The projects the service serves: one session per folder, opened on
 *  demand and held until the service stops. The host that composes the
 *  service builds each project's roots, so this is its port. */
export class ServiceProjects extends Context.Service<
  ServiceProjects,
  {
    /** The storage root every project's store sits under. */
    readonly storageRoot: string;
    /** The session of `workspace`, opened on first use. */
    readonly open: (workspace: string) => Effect.Effect<SessionHandle, Error>;
    /** The sessions open now, by storage root. */
    readonly opened: Effect.Effect<ReadonlyMap<string, SessionHandle>>;
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
    /** Stop now, or drain first; returns once the stop is asked. */
    readonly stop: (drain: boolean) => Effect.Effect<void>;
  }
>()('@texra/server/ServiceControl') {}

/** The tasks the service runs now, across its open projects; with
 *  `parked` false, only those at work, not a conversation waiting for its
 *  next message. */
export const runningTasks = Effect.fn('server.runningTasks')(function* (
  projects: Context.Service.Shape<typeof ServiceProjects>,
  parked = true,
): Effect.fn.Return<number> {
  let running = 0;
  for (const session of (yield* projects.opened).values()) {
    const view = yield* SubscriptionRef.get(session.view.ref);
    for (const run of view.runs.values())
      if (
        run.ownedHere &&
        isLiveRun(run) &&
        (parked || run.status !== RUN_PHASE.WAITING)
      )
        running += 1;
  }
  return running;
});

/** The live run `runId` continues in: itself, or the live run its parent
 *  chain reaches; null when `runId` is not live here. */
function liveRoot(
  view: SessionView,
  session: SessionHandle,
  runId: RunId,
): RunId | null {
  if (!session.runs.isLive(runId)) return null;
  let root = runId;
  for (
    let parent = view.runs.get(root)?.parentId;
    parent != null && session.runs.isLive(parent);
    parent = view.runs.get(root)?.parentId
  )
    root = parent;
  return root;
}

/** A request error in its wire shape: the fields the wire schema names. */
const wireError = (error: RequestError): RequestErrorWire =>
  RequestErrorWireSchema.parse(error);

const failed = (message: string): TaskFailed => ({
  _tag: 'TaskFailed',
  message,
});

/** A handler that died answers `Internal` under a reference the service
 *  log carries the cause under, as the session bridge does. */
const internal = (cause: Cause.Cause<unknown>) =>
  Effect.gen(function* () {
    const ref = randomUUID();
    yield* Effect.logError(`Service request ${ref} failed`, cause);
    return wireError(new Internal({ ref }));
  });

/**
 * Run `program` (a launch or a resume) in the service's fiber set and
 * answer once it reports its run admitted; a program that ends first
 * answers with its failure.
 */
function admit<Admitted extends RunId | null>(
  runs: FiberSet.FiberSet,
  program: (
    admitted: Deferred.Deferred<Admitted, TaskFailed>,
  ) => Effect.Effect<unknown, Error, ProcessServices>,
): Effect.Effect<Admitted, TaskFailed, ProcessServices> {
  return Effect.gen(function* () {
    const admitted = yield* Deferred.make<Admitted, TaskFailed>();
    const ended = (message: string) =>
      Deferred.fail(admitted, failed(message)).pipe(Effect.asVoid);
    yield* FiberSet.run(
      runs,
      program(admitted).pipe(
        Effect.catchCause((cause) =>
          // The service stopping interrupts its tasks; that is no failure.
          Cause.hasInterruptsOnly(cause)
            ? ended('The service stopped before the task started.')
            : Effect.logWarning(
                'A service task ended with a failure',
                cause,
              ).pipe(
                Effect.andThen(ended(toErrorMessage(Cause.squash(cause)))),
              ),
        ),
        Effect.ensuring(ended('The task ended before it started.')),
      ),
    );
    return yield* Deferred.await(admitted);
  });
}

/** The handlers of {@link TexraRpcs}, over the two ports above. */
export const serviceHandlers = TexraRpcs.toLayer(
  Effect.gen(function* () {
    const projects = yield* ServiceProjects;
    const control = yield* ServiceControl;
    const runs = yield* FiberSet.make();
    const scope = yield* Effect.scope;
    let ports = 0;
    const refuseWhileDraining = Effect.gen(function* () {
      if (yield* control.draining)
        return yield* Effect.fail(
          failed('The service is shutting down; start the task again.'),
        );
    });
    const hosts = yield* makeHostWindows;
    const presented = new WeakSet<SessionHandle>();
    /** The service's presentation surface on a project's session, given
     *  once: what its runs ask of a host goes to the project's windows. */
    const present = (session: SessionHandle): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (presented.has(session)) return Effect.void;
        presented.add(session);
        return hosts.adopt(session).pipe(Scope.provide(scope));
      });
    const openSession = (workspace: string) =>
      projects.open(workspace).pipe(Effect.tap(present));
    const open = (workspace: string) =>
      openSession(workspace).pipe(
        Effect.mapError((error) => failed(error.message)),
      );
    return {
      'service.hello': () =>
        Effect.gen(function* () {
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
            const session = yield* open(workspace);
            const port = `service-watch-${(ports += 1)}`;
            // The client renders its own host state; the service has none.
            const host = yield* SubscriptionRef.make<HostSnapshot | null>(null);
            return frameSubscription(
              {
                key: session.roots.storage,
                view: session.view.ref,
                inputs: session.view.inputs,
                setTranscriptSubscriptions: session.view.subscribe,
              },
              port,
              host,
              { ...subscribe, session: session.roots.storage },
            ).pipe(Stream.ensuring(session.view.subscribe(port, [])));
          }),
        ),
      'task.ended': ({ workspace, runId }) =>
        Effect.flatMap(open(workspace), (session) =>
          Effect.map(runEnded(session, runId), ({ outcome, output }) => ({
            outcome,
            output,
          })),
        ),
      'request.preview': ({ workspace, requestId }) =>
        open(workspace).pipe(
          Effect.flatMap((session) => hosts.preview(session, requestId)),
        ),
      'task.request': ({ workspace, request }) =>
        openSession(workspace).pipe(
          Effect.mapError((error): RequestErrorWire => ({
            _tag: 'Rejected',
            reason: error.message,
          })),
          Effect.flatMap((session) =>
            session.requests.request(request).pipe(Effect.mapError(wireError)),
          ),
          Effect.catchDefect((defect) =>
            internal(Cause.die(defect)).pipe(Effect.flatMap(Effect.fail)),
          ),
        ),
      'task.start': ({
        workspace,
        runId,
        config,
        continues,
        preferHelperModel,
        ownApiKeyFallback,
        approveDelegatedWork,
      }) =>
        Effect.gen(function* () {
          yield* refuseWhileDraining;
          const session = yield* open(workspace);
          return yield* admit<RunId>(runs, (admitted) =>
            runAgent(
              { config, runId },
              {
                session,
                preferHelperModel,
                ownApiKeyFallback,
                // Admitted once the run is registered, so a `task.ended`
                // that follows the answer finds it.
                approveDelegatedWork,
                onRun: (registered) =>
                  Deferred.succeed(admitted, registered).pipe(Effect.asVoid),
                ...(continues !== null && { continues }),
              },
            ),
          );
        }),
      'task.model': ({ workspace, runId, model }) =>
        Effect.flatMap(open(workspace), (session) => {
          const controls = session.runs.getHandle(runId)?.controls;
          if (controls === undefined)
            return Effect.fail(
              failed('The task is not running; resume it to switch its model.'),
            );
          return controls
            .switchModel(model)
            .pipe(Effect.mapError((error) => failed(error.message)));
        }),
      'host.attach': ({ workspace, capabilities }) =>
        Stream.unwrap(
          Effect.map(
            projects
              .open(workspace)
              .pipe(Effect.mapError((error) => failed(error.message))),
            (session) =>
              hosts.attach(session, capabilities).pipe(
                // The session's surface is given once the window is held,
                // so a first attach is never told that no window is.
                Stream.tap((frame) =>
                  frame.kind === 'attached' ? present(session) : Effect.void,
                ),
              ),
          ),
        ),
      'host.focus': ({ attachment }) => hosts.focus(attachment),
      'host.answer': ({ id, answer }) => hosts.answer(id, answer),
      'project.policy': ({ workspace, policy }) =>
        open(workspace).pipe(
          Effect.map((session) => session.approvals.setPolicy(policy)),
        ),
      'task.resume': ({ workspace, runId }) =>
        Effect.gen(function* () {
          yield* refuseWhileDraining;
          const session = yield* open(workspace);
          // A run this service is running needs no resume: the client that
          // asks takes up the conversation it belongs to, where it is (a
          // chat left it waiting here).
          const live = liveRoot(
            yield* SubscriptionRef.get(session.view.ref),
            session,
            runId,
          );
          const resumed =
            live ??
            (yield* admit<RunId | null>(runs, (admitted) =>
              Effect.gen(function* () {
                let resolved: RunId = runId;
                const result = yield* resumeRun(runId, {
                  session,
                  // Admitted once the resumed generation is registered (the
                  // parent, for an owned child), so a `task.ended` that
                  // follows the answer waits for it.
                  onRun: (registered) =>
                    Deferred.succeed(admitted, registered).pipe(Effect.asVoid),
                  onResumeResolved: (resumed) =>
                    Effect.sync(() => {
                      resolved = resumed;
                    }),
                });
                // A resume that joined one already in flight registers no
                // generation of its own: the run is registered by now.
                if ('started' in result)
                  yield* Deferred.succeed(admitted, resolved);
                // Blocked, not failed: it stays interrupted until what it needs is back.
                if ('failed' in result && result.failed === 'blocked')
                  return yield* Deferred.succeed(admitted, null);
                if ('failed' in result)
                  return yield* Effect.fail(
                    new Error(describeFollowUpFailure(result.failed)),
                  );
                if (result.completion) yield* result.completion;
              }).pipe(Effect.mapError(ensureError)),
            ));
          if (resumed === null) return null;
          // A workflow settles with its whole run, whose output the window
          // opens then; it tells which by the run's own config.
          const config = yield* getRunRecords(session, resumed)
            .readConfig()
            .pipe(Effect.mapError((error) => failed(toErrorMessage(error))));
          return {
            runId: resumed,
            workflow: config !== null && isDocumentTaskConfig(config),
          };
        }),
    };
  }),
);
