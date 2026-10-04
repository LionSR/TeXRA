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
  Stream,
  SubscriptionRef,
} from 'effect';

import { describeFollowUpFailure } from '@agent/followUp/ToolUseFollowUp';
import { resumeRun } from '@agent/runtime/resumeRun';
import { runAgent } from '@agent/runtime/runAgent';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { frameSubscription } from '@controllers/session/SessionFramer';
import type { ProcessServices } from '@platform/processRuntime';
import type { RunId } from '@shared/schemas';
import type { HostSnapshot } from '@shared/session/hostSnapshot';
import { Internal, type RequestError } from '@shared/session/requestErrors';
import {
  RequestErrorWireSchema,
  type RequestErrorWire,
} from '@shared/session/sessionFrames';
import { isLiveRun } from '@shared/session/sessionView';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

import {
  PROTOCOL_VERSION,
  TexraRpcs,
  type ServiceInfo,
  type TaskFailed,
} from './protocol';
import { listTasks } from './taskList';

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

/** The tasks the service runs now, across its open projects. */
export const runningTasks = Effect.fn('server.runningTasks')(function* (
  projects: Context.Service.Shape<typeof ServiceProjects>,
): Effect.fn.Return<number> {
  let running = 0;
  for (const session of (yield* projects.opened).values()) {
    const view = yield* SubscriptionRef.get(session.view);
    for (const run of view.runs.values())
      if (run.ownedHere && isLiveRun(run)) running += 1;
  }
  return running;
});

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
function admit<A>(
  runs: FiberSet.FiberSet,
  program: (
    admitted: Deferred.Deferred<RunId, TaskFailed>,
  ) => Effect.Effect<A, Error, ProcessServices>,
): Effect.Effect<RunId, TaskFailed, ProcessServices> {
  return Effect.gen(function* () {
    const admitted = yield* Deferred.make<RunId, TaskFailed>();
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
    let ports = 0;
    const refuseWhileDraining = Effect.gen(function* () {
      if (yield* control.draining)
        return yield* Effect.fail(
          failed('The service is shutting down; start the task again.'),
        );
    });
    const open = (workspace: string) =>
      projects
        .open(workspace)
        .pipe(Effect.mapError((error) => failed(error.message)));
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
                view: session.view,
                inputs: session.inputs,
                setTranscriptSubscriptions: session.subscriptions.set,
              },
              port,
              host,
              { ...subscribe, session: session.roots.storage },
            ).pipe(Stream.ensuring(session.subscriptions.set(port, [])));
          }),
        ),
      'task.request': ({ workspace, request }) =>
        projects.open(workspace).pipe(
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
      'task.start': ({ workspace, runId, config, continues }) =>
        Effect.gen(function* () {
          yield* refuseWhileDraining;
          const session = yield* open(workspace);
          return yield* admit(runs, (admitted) =>
            runAgent(
              { config, runId },
              {
                session,
                enforceCategory: true,
                onRunResolved: (resolved) => {
                  if (continues !== null && continues !== resolved)
                    session.approvals.registerRunParent(resolved, continues);
                  Deferred.doneUnsafe(admitted, Effect.succeed(resolved));
                },
              },
            ),
          );
        }),
      'project.policy': ({ workspace, policy }) =>
        open(workspace).pipe(
          Effect.map((session) => session.setApprovalPolicy(policy)),
        ),
      'task.resume': ({ workspace, runId }) =>
        Effect.gen(function* () {
          yield* refuseWhileDraining;
          const session = yield* open(workspace);
          return yield* admit(runs, (admitted) =>
            Effect.gen(function* () {
              const result = yield* resumeRun(runId, {
                session,
                onResumeResolved: (resumed) =>
                  Deferred.succeed(admitted, resumed).pipe(Effect.asVoid),
              });
              if ('failed' in result)
                return yield* Effect.fail(
                  new Error(describeFollowUpFailure(result.failed)),
                );
              if (result.completion) yield* result.completion;
            }).pipe(Effect.mapError(ensureError)),
          );
        }),
    };
  }),
);
