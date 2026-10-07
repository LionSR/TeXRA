/**
 * `texra serve`: the service's lifetime over its own socket. It refuses to
 * start beside a live service, listens on a socket only it uses, writes its
 * record, and then lives until one of four things ends it:
 *
 * - a stop: `service.stop` without a drain, or the host's own shutdown;
 * - a drain (`service.stop` with `drain`, the upgrade path): the record is
 *   released at once, so a newer service can start and be found while this
 *   one finishes the tasks at work, and it exits when they end (a
 *   conversation parked here stops with it, resumable);
 * - replacement: another service's record took this one's place (two
 *   started at once), and nothing works here;
 * - idleness: no client connected and no task running for `idleAfter`.
 *
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
  probeRecordedService,
  WINDOWS_UNSUPPORTED,
  type ServiceUnavailable,
} from './client';
import {
  prepareServiceDirectories,
  readServiceRecord,
  removeDeadSockets,
  removeServiceFiles,
  servicePaths,
  writeServiceRecord,
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
} from './protocol';
import type { ProcessServices } from '@texra-ai/harness';

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
type ServeExit = 'stopped' | 'drained' | 'idle' | 'replaced';

interface ServeOptions {
  /** Exit after this long with no client and no running task. */
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

/** How often the idle and takeover checks run. */
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
  ProcessServices | ServiceProjects | Scope.Scope
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
  const existing = yield* probeRecordedService(projects.storageRoot);
  if (existing !== null)
    return yield* Effect.fail(new ServiceAlreadyRunning({ info: existing }));
  yield* removeDeadSockets(paths);
  // A socket of this pid is a dead process's whose pid this one reuses: no
  // other live process can have it.
  yield* fs
    .remove(socket, { force: true })
    .pipe(
      Effect.mapError((cause) => new ServiceListenFailed({ socket, cause })),
    );

  const startedAt = yield* Clock.currentTimeMillis;
  const ended = yield* Deferred.make<ServeExit>();
  const draining = yield* Ref.make(false);
  let clients: Effect.Effect<number> = Effect.succeed(0);
  // Once: a drain releases the record early, and the exit releases what is
  // left.
  let released = false;
  const release = Effect.suspend(() => {
    if (released) return Effect.void;
    released = true;
    return removeServiceFiles(paths, process.pid);
  }).pipe(Effect.provideService(FileSystem.FileSystem, fs));
  const control: Context.Service.Shape<typeof ServiceControl> = {
    version: BUILD_VERSION,
    socket,
    startedAt,
    clients: Effect.suspend(() => clients),
    draining: Ref.get(draining),
    idleAfter: Duration.fromInputUnsafe(options.idleAfter),
    stop: (drain) =>
      drain
        ? Ref.set(draining, true).pipe(
            // Release the record first: a newer service can start and be
            // found while this one finishes its tasks on the connections
            // it already holds.
            Effect.andThen(release),
          )
        : Deferred.succeed(ended, 'stopped').pipe(Effect.asVoid),
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
  yield* writeServiceRecord(paths, {
    pid: process.pid,
    protocol: PROTOCOL_VERSION,
    version: BUILD_VERSION,
    socket,
    startedAt,
  }).pipe(
    Effect.mapError((cause) => new ServiceListenFailed({ socket, cause })),
  );
  yield* Effect.addFinalizer(() => release);
  yield* Effect.logInfo(
    `TeXRA service ${BUILD_VERSION} listening on ${socket}`,
  );

  const idleAfter = Duration.toMillis(options.idleAfter);
  let idleSince: number | null = null;
  const check = Effect.gen(function* () {
    const running = yield* runningTasks(projects);
    // A drained or replaced service waits for the tasks at work; a
    // conversation parked here is stopped with the service, resumable.
    const working = yield* runningTasks(projects, false);
    const now = yield* Clock.currentTimeMillis;
    if (yield* Ref.get(draining)) {
      if (working === 0) yield* Deferred.succeed(ended, 'drained');
      return;
    }
    // Another service's record replaced this one's (two started at once):
    // no new client finds this one, so it leaves once nothing works here
    // and no client it already answered is connected. A record it cannot
    // read is not a replacement.
    const record = yield* readServiceRecord(paths);
    if (
      record !== null &&
      record.pid !== process.pid &&
      working === 0 &&
      (yield* control.clients) === 0
    ) {
      yield* Deferred.succeed(ended, 'replaced');
      return;
    }
    const busy = running > 0 || (yield* control.clients) > 0;
    idleSince = busy ? null : (idleSince ?? now);
    if (idleSince !== null && now - idleSince >= idleAfter)
      yield* Deferred.succeed(ended, 'idle');
  });
  yield* Effect.forkScoped(
    check.pipe(Effect.repeat(Schedule.spaced(CHECK_INTERVAL))),
  );
  yield* Effect.forkScoped(
    Deferred.await(options.shutdown).pipe(
      Effect.andThen(Deferred.succeed(ended, 'stopped')),
    ),
  );
  const exit = yield* Deferred.await(ended);
  yield* Effect.logInfo(`TeXRA service exiting: ${exit}`);
  yield* options.settle;
  yield* Effect.sleep(FRAME_FLUSH);
  return exit;
}, Effect.scoped);
