/**
 * `texra serve`: the service's lifetime over its own socket. It listens on
 * a socket only it uses, claims the record (refusing to start beside a live
 * service), and then lives until one of three things ends it:
 *
 * - a stop: `service.stop` without a drain, or the host's own shutdown;
 * - a drain (`service.stop` with `drain`, the upgrade path): the record is
 *   released at once, so a newer service can start and be found while this
 *   one finishes the tasks at work, and it exits when they end (a
 *   conversation waiting here for its next message stops with it,
 *   resumable);
 * - idleness: no client connected and no task at work for `idleAfter` (a
 *   conversation waiting for its next message stops with it, resumable, as
 *   in a drain).
 *
 * Whichever ends it, it leaves as a drain does first: no task starts and
 * the record is released, so no client finds a service that is exiting.
 * It never starts at login: a client starts it detached when none answers.
 * The sessions it opened are the host's to close once this returns.
 */
import * as NodeSocketServer from '@effect/platform-node/NodeSocketServer';
import {
  Clock,
  Context,
  Data,
  Deferred,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Ref,
  Schedule,
  type Scope,
} from 'effect';
import { RpcSerialization, RpcServer } from 'effect/rpc';

import {
  GlobalValues,
  type ProcessServices,
  type Sessions,
} from '@texra-ai/harness';
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
  runningTasks,
  ServiceControl,
  serviceHandlers,
  ServiceProjects,
} from './handlers';
import {
  BUILD_VERSION,
  PROTOCOL_VERSION,
  TexraRpcs,
  type ServiceInfo,
  type ServiceRecord,
} from './protocol';

/** A live service already answers on this storage root's socket. */
export class ServiceAlreadyRunning extends Data.TaggedError(
  'ServiceAlreadyRunning',
)<{ readonly info: ServiceInfo }> {
  override get message(): string {
    return `A TeXRA service is already running (pid ${this.info.pid}, ${this.info.socket}).`;
  }
}

/** The service could not listen on its socket. */
export class ServiceListenFailed extends Data.TaggedError(
  'ServiceListenFailed',
)<{ readonly socket: string; readonly cause: unknown }> {
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
  /** Stop and settle every task, run once the service is ending and while
   *  its clients are still connected, so they see each task's last rows. */
  readonly settle: Effect.Effect<void>;
}

/** How long the watch streams get to carry the settled tasks' last rows
 *  (their framers cut every 16 ms) before the socket closes. */
const FRAME_FLUSH = '250 millis';

/** How often the idle and drain checks run. */
const CHECK_INTERVAL = '1 second';

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
  ProcessServices | Sessions | ServiceProjects | Scope.Scope
> {
  if (process.platform === 'win32')
    return yield* Effect.fail(
      new ServiceListenFailed({
        socket: '',
        cause: new Error(WINDOWS_UNSUPPORTED),
      }),
    );
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
  const record: ServiceRecord = {
    pid: process.pid,
    protocol: PROTOCOL_VERSION,
    version: BUILD_VERSION,
    socket,
    startedAt,
  };
  const values = yield* GlobalValues;
  const ended = yield* Deferred.make<ServeExit>();
  // Whether the service is leaving, the task admissions under way, and how
  // many were ever admitted: one value, so an admission is claimed in the
  // same step that checks for a drain, a drain never misses a start that is
  // not a held run yet, and an idle exit never ends one begun since it
  // looked.
  const admissions = yield* Ref.make({
    draining: false,
    admitting: 0,
    admitted: 0,
  });
  let clients: Effect.Effect<number> = Effect.succeed(0);
  // Once: a drain releases the record early, and the exit releases what is
  // left.
  let released = false;
  const release = Effect.suspend(() => {
    if (released) return Effect.void;
    released = true;
    return releaseServiceRecord(paths, record);
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(GlobalValues, values),
  );
  // No task starts from here on, and the record goes first: a newer
  // service can start and be found while this one finishes on the
  // connections it already holds.
  const leave = Ref.update(admissions, (state) => ({
    ...state,
    draining: true,
  })).pipe(Effect.andThen(release));
  // Every end leaves first, so no task is admitted once the run has ended.
  const end = (exit: ServeExit) =>
    leave.pipe(Effect.andThen(Deferred.succeed(ended, exit)), Effect.asVoid);
  const control: Context.Service.Shape<typeof ServiceControl> = {
    version: BUILD_VERSION,
    socket,
    startedAt,
    clients: Effect.suspend(() => clients),
    draining: Effect.map(Ref.get(admissions), (state) => state.draining),
    admission: Effect.acquireRelease(
      Ref.modify(admissions, (state) =>
        state.draining
          ? [false, state]
          : [
              true,
              {
                ...state,
                admitting: state.admitting + 1,
                admitted: state.admitted + 1,
              },
            ],
      ),
      (admitted) =>
        admitted
          ? Ref.update(admissions, (state) => ({
              ...state,
              admitting: state.admitting - 1,
            }))
          : Effect.void,
    ),
    idleAfter: Duration.fromInputUnsafe(options.idleAfter),
    stop: (drain) => (drain ? leave : end('stopped')),
  };
  const protocol = yield* Layer.build(
    RpcServer.layerProtocolSocketServer.pipe(
      Layer.provide(RpcSerialization.layerNdjson),
      Layer.provide(NodeSocketServer.layer({ path: socket })),
    ),
  ).pipe(
    Effect.map((context) => Context.get(context, RpcServer.Protocol)),
    Effect.mapError((cause) => new ServiceListenFailed({ socket, cause })),
  );
  clients = protocol.clientIds.pipe(Effect.map((ids) => ids.size));
  yield* fs
    .chmod(socket, 0o600)
    .pipe(
      Effect.mapError((cause) => new ServiceListenFailed({ socket, cause })),
    );
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
    return yield* Effect.fail(new ServiceAlreadyRunning({ info: holder }));
  yield* Effect.addFinalizer(() => release);
  yield* Effect.logInfo(
    `TeXRA service ${BUILD_VERSION} listening on ${socket}`,
  );

  const idleAfter = Duration.toMillis(options.idleAfter);
  let idleSince: number | null = null;
  const check = Effect.gen(function* () {
    // Read before the runs: once draining, no admission starts, and one
    // that ended since this read holds its run.
    const { draining, admitting, admitted } = yield* Ref.get(admissions);
    // Only the tasks at work hold the service, draining or idle: a
    // conversation waiting here for its next message is stopped with
    // the service, resumable, so one a closed chat left here does not keep
    // the service up for good.
    const working = yield* runningTasks(projects, false);
    const now = yield* Clock.currentTimeMillis;
    if (draining) {
      if (working === 0 && admitting === 0)
        yield* Deferred.succeed(ended, 'drained');
      return;
    }
    const busy = working > 0 || admitting > 0 || (yield* control.clients) > 0;
    idleSince = busy ? null : (idleSince ?? now);
    if (idleSince === null || now - idleSince < idleAfter) return;
    // Idle only if nothing was admitted since the read above: the leave is
    // the same step as that check, so a start that won it keeps its run.
    const idle = yield* Ref.modify(admissions, (state) =>
      state.draining || state.admitting > 0 || state.admitted !== admitted
        ? [false, state]
        : [true, { ...state, draining: true }],
    );
    if (idle) yield* end('idle');
  });
  yield* Effect.forkScoped(
    check.pipe(Effect.repeat(Schedule.spaced(CHECK_INTERVAL))),
  );
  yield* Effect.forkScoped(
    Deferred.await(options.shutdown).pipe(Effect.andThen(end('stopped'))),
  );
  const exit = yield* Deferred.await(ended);
  yield* Effect.logInfo(`TeXRA service exiting: ${exit}`);
  yield* leave;
  yield* options.settle;
  yield* Effect.sleep(FRAME_FLUSH);
  return exit;
}, Effect.scoped);
