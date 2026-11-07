/**
 * `texra serve`: the service's lifetime over its own socket. It listens on
 * a socket only it uses, claims the record (refusing to start beside a live
 * service), and then lives until one of three things ends it:
 *
 * - a stop: `service.stop` without a drain, or the host's own shutdown;
 * - a drain (`service.stop` with `drain`, the upgrade path): no task starts,
 *   the tasks at work finish, and it exits when they end (a conversation
 *   waiting here for its next message stops with it, resumable). It keeps
 *   its record and its socket meanwhile: one service serves a storage root
 *   at a time, and the client that asked waits for the socket to close
 *   before it starts the next build's (`ensureService`), so a project is
 *   never held by two processes;
 * - idleness: no project open (each is released once nothing has held it
 *   for `idleAfter`, a run at work included) and no task admitting, for
 *   `idleAfter` more (a conversation waiting for its next message stops
 *   with it, resumable, as in a drain).
 *
 * Whichever ends it, it leaves as a drain does first: no task starts; the
 * record is released as it exits. It never starts at login: a client starts it detached when none answers.
 * The sessions it opened are the host's to close once this returns. Every
 * fact the lifetime follows is a published one (the projects' load, the
 * admissions, the watch streams), never a poll.
 */
import * as NodeSocketServer from '@effect/platform-node/NodeSocketServer';
import {
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Schema,
  type Scope,
  Stream,
  SubscriptionRef,
} from 'effect';
import { RpcSerialization, RpcServer } from 'effect/rpc';

import { type Sessions } from '@texra-ai/harness';
import { GlobalValues, type ProcessServices } from '@texra-ai/harness/host';
import {
  probeService,
  ServiceUnavailable,
  WINDOWS_UNSUPPORTED,
} from './client';
import {
  claimServiceRecord,
  prepareServiceDirectories,
  releaseServiceRecord,
  removeDeadSockets,
  servicePaths,
} from './discovery';
import {
  ServiceControl,
  serviceHandlers,
  ServiceProjects,
  runningTasks,
} from './handlers';
import {
  BUILD_VERSION,
  ServiceInfoSchema,
  TexraRpcs,
  type ServiceRecord,
} from './protocol';
import type { HostWindows } from './hostWindows';

/** A live service already answers on this storage root's socket. */
export class ServiceAlreadyRunning extends Schema.TaggedError<ServiceAlreadyRunning>()(
  'ServiceAlreadyRunning',
  {
    info: ServiceInfoSchema,
  },
) {
  override get message(): string {
    return `A TeXRA service is already running (pid ${this.info.pid}, ${this.info.socket}).`;
  }
}

/** The service could not listen on its socket. */
class ServiceListenFailed extends Schema.TaggedError<ServiceListenFailed>()(
  'ServiceListenFailed',
  {
    socket: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `The TeXRA service could not listen on ${this.socket}.`;
  }
}

/** How a service run ended. */
type ServeExit = 'stopped' | 'drained' | 'idle';

interface ServeOptions {
  /** Exit after this long with no client and no task at work. */
  readonly idleAfter: Duration.Input;
  /** The host's own stop (a signal): ends the run as a `stop` would. */
  readonly shutdown: Deferred.Deferred<void>;
  /** Stop and finish every task, run once the service is ending and while
   *  its clients are still connected, so they see each task's last rows. */
  readonly settle: Effect.Effect<void>;
}

/** How long the watch streams get, after the tasks are stopped, to end
 *  with their sessions and carry the last rows before the socket closes: a
 *  deadline for a client that is not reading, not a wait. */
const WATCH_END_DEADLINE = '5 seconds';

/**
 * Serve {@link TexraRpcs} on the storage root's socket until the service
 * stops, drains or idles out. The projects port is the host's: it opens
 * each project's session with the host's roots.
 */
export const serve = Effect.fn('server.serve')(function* (
  options: ServeOptions,
): Effect.fn.Return<
  ServeExit,
  ServiceAlreadyRunning | ServiceListenFailed | ServiceUnavailable,
  ProcessServices | Sessions | ServiceProjects | HostWindows | Scope.Scope
> {
  if (process.platform === 'win32')
    return yield* new ServiceListenFailed({
      socket: '',
      cause: new Error(WINDOWS_UNSUPPORTED),
    });
  const fs = yield* FileSystem.FileSystem;
  const projects = yield* ServiceProjects;
  const paths = servicePaths(projects.storageRoot);
  // This service's own socket: a retired one that exits later can only
  // remove its own file, never this one's.
  const socket = paths.socketFor(process.pid);
  yield* prepareServiceDirectories(paths).pipe(
    Effect.mapError((cause) => new ServiceListenFailed({ socket, cause })),
  );
  yield* removeDeadSockets(paths);
  // A socket of this pid is a dead process's whose pid this one reuses: no
  // other live process can have it.
  yield* fs
    .remove(socket, { force: true })
    .pipe(
      Effect.mapError((cause) => new ServiceListenFailed({ socket, cause })),
    );

  const startedAt = yield* Clock.currentTimeMillis;
  const record: ServiceRecord = { pid: process.pid, socket, startedAt };
  const values = yield* GlobalValues;
  const ended = yield* Deferred.make<ServeExit>();
  // The service's own lifecycle facts: why it is leaving, if it is (a
  // drain finishes its tasks first, an end stops them), and the task
  // admissions under way; one value, so an admission is claimed in the
  // same step that checks for a leave.
  const state = yield* SubscriptionRef.make<{
    readonly leaving: 'drain' | 'end' | null;
    readonly admitting: number;
  }>({ leaving: null, admitting: 0 });
  // Once, as the service exits.
  const release = yield* Effect.cached(
    releaseServiceRecord(paths, record).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(GlobalValues, values),
    ),
  );
  // No task starts from here on. The first reason stands.
  const leave = (why: 'drain' | 'end') =>
    SubscriptionRef.update(state, (now) => ({
      ...now,
      leaving: now.leaving ?? why,
    }));
  // Every end leaves first, so no task is admitted once the run has ended.
  const end = (exit: ServeExit) =>
    leave('end').pipe(
      Effect.andThen(Deferred.succeed(ended, exit)),
      Effect.asVoid,
    );
  const protocol = yield* Layer.build(
    RpcServer.layerProtocolSocketServer.pipe(
      Layer.provide(RpcSerialization.layerNdjson),
      Layer.provide(NodeSocketServer.layer({ path: socket })),
    ),
  ).pipe(
    Effect.map((context) => Context.get(context, RpcServer.Protocol)),
    Effect.mapError((cause) => new ServiceListenFailed({ socket, cause })),
  );
  yield* fs
    .chmod(socket, 0o600)
    .pipe(
      Effect.mapError((cause) => new ServiceListenFailed({ socket, cause })),
    );
  const control: Context.Service.Shape<typeof ServiceControl> = {
    version: BUILD_VERSION,
    socket,
    startedAt,
    clients: Effect.map(protocol.clientIds, (ids) => ids.size),
    draining: Effect.map(
      SubscriptionRef.get(state),
      (now) => now.leaving !== null,
    ),
    admission: Effect.acquireRelease(
      SubscriptionRef.modify(state, (now) =>
        now.leaving !== null
          ? [false, now]
          : [true, { ...now, admitting: now.admitting + 1 }],
      ),
      (admitted) =>
        admitted
          ? SubscriptionRef.update(state, (now) => ({
              ...now,
              admitting: now.admitting - 1,
            }))
          : Effect.void,
    ),
    watching: yield* SubscriptionRef.make(0),
    stop: (drain) => (drain ? leave('drain') : end('stopped')),
  };
  yield* Effect.forkScoped(
    RpcServer.make(TexraRpcs).pipe(
      Effect.provide(
        serviceHandlers.pipe(
          Layer.provide(Layer.succeed(ServiceControl)(control)),
        ),
      ),
      Effect.provideService(RpcServer.Protocol, protocol),
    ),
  );
  // Claimed once it listens, so a record always names a socket that
  // accepts: one nobody accepts on is a dead service's.
  const holder = yield* claimServiceRecord(record, (held) =>
    probeService(held.socket),
  ).pipe(
    Effect.catchTags({
      DatabaseReadFailed: (error) =>
        Effect.fail(
          new ServiceUnavailable({
            reason: `The service record could not be read: ${error.message}`,
          }),
        ),
      DatabaseWriteFailed: (error) =>
        Effect.fail(
          new ServiceUnavailable({
            reason: `The service record could not be written: ${error.message}`,
          }),
        ),
    }),
  );
  if (holder !== null)
    return yield* new ServiceAlreadyRunning({ info: holder });
  yield* Effect.addFinalizer(() => release);
  yield* Effect.logInfo(
    `TeXRA service ${BUILD_VERSION} listening on ${socket}`,
  );

  // The facts the lifetime follows, as they change: the service's own and
  // its projects' load.
  const facts = Stream.zipLatest(
    SubscriptionRef.changes(state),
    SubscriptionRef.changes(projects.load),
  );
  // A drain ends once no task is at work and none is admitting. The
  // projects' load is the trigger; the decision reads the registries, which
  // hold a run as its admission ends, where the view shows it only once its
  // rows fold.
  yield* Effect.forkScoped(
    facts.pipe(
      Stream.filterEffect(([now]) =>
        now.leaving === 'drain' && now.admitting === 0
          ? Effect.map(runningTasks(projects, true), (atWork) => atWork === 0)
          : Effect.succeed(false),
      ),
      Stream.runHead,
      Effect.andThen(Deferred.succeed(ended, 'drained')),
    ),
  );
  // Idle: no project open and nothing admitting, for `idleAfter`. The leave
  // is decided in the same step that checks the admissions again, so a
  // start that landed meanwhile keeps its run.
  yield* Effect.forkScoped(
    facts.pipe(
      Stream.map(
        ([now, load]) =>
          now.leaving === null && now.admitting === 0 && load.open === 0,
      ),
      Stream.changes,
      Stream.debounce(options.idleAfter),
      Stream.filter((idle) => idle),
      Stream.mapEffect(() =>
        SubscriptionRef.modify(state, (now) =>
          now.leaving === null && now.admitting === 0
            ? [true, { ...now, leaving: 'end' as const }]
            : [false, now],
        ),
      ),
      Stream.filter((left) => left),
      Stream.runHead,
      Effect.andThen(end('idle')),
    ),
  );
  yield* Effect.forkScoped(
    Deferred.await(options.shutdown).pipe(Effect.andThen(end('stopped'))),
  );
  const exit = yield* Deferred.await(ended);
  yield* Effect.logInfo(`TeXRA service exiting: ${exit}`);
  yield* leave('end');
  yield* options.settle;
  // The watch streams end with the sessions the settle closed, each having
  // carried its tasks' last rows; the socket closes once they have.
  yield* SubscriptionRef.changes(control.watching).pipe(
    Stream.filter((open) => open === 0),
    Stream.runHead,
    Effect.timeout(WATCH_END_DEADLINE),
    Effect.catch(() =>
      Effect.logInfo(
        `A watch stream was still open ${WATCH_END_DEADLINE} after the tasks stopped; closing the socket.`,
      ),
    ),
  );
  return exit;
}, Effect.scoped);
