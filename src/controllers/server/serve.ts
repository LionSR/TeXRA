/**
 * `texra serve`: the service's lifetime over its socket. It refuses to start
 * beside a live service, takes over a dead one's socket, listens, writes its
 * record, and then lives until one of three things ends it:
 *
 * - a stop: `service.stop` without a drain, or the host's own shutdown;
 * - a drain (`service.stop` with `drain`, the upgrade path): the record and
 *   the socket path are released at once, so a newer service can start
 *   while this one finishes the tasks it runs, and it exits when they end;
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
  Option,
  Ref,
  Schedule,
  type Scope,
} from 'effect';
import { RpcSerialization, RpcServer } from 'effect/rpc';

import type { ProcessServices } from '@platform/processRuntime';

import {
  probeService,
  WINDOWS_UNSUPPORTED,
  type ServiceUnavailable,
} from './client';
import {
  prepareServiceDirectories,
  removeServiceFiles,
  servicePaths,
  type ServiceOwnership,
  writeServiceRecord,
} from './discovery';
import {
  runningTasks,
  ServiceControl,
  serviceHandlers,
  ServiceProjects,
} from './handlers';
import { PROTOCOL_VERSION, TexraRpcs, type ServiceInfo } from './protocol';

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
  /** The build that serves, reported by `service.hello`. */
  readonly version: string;
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
  yield* prepareServiceDirectories(paths).pipe(
    Effect.mapError(
      (cause) => new ServiceListenFailed({ socket: paths.socket, cause }),
    ),
  );
  const existing = yield* probeService(paths.socket);
  if (existing !== null)
    return yield* Effect.fail(new ServiceAlreadyRunning({ info: existing }));

  const startedAt = yield* Clock.currentTimeMillis;
  const ended = yield* Deferred.make<ServeExit>();
  const draining = yield* Ref.make(false);
  let clients: Effect.Effect<number> = Effect.succeed(0);
  // Known once the socket is bound; until then there is nothing to remove.
  let own: ServiceOwnership | null = null;
  const release = Effect.suspend(() =>
    own === null ? Effect.void : removeServiceFiles(paths, own),
  ).pipe(Effect.provideService(FileSystem.FileSystem, fs));
  const control: Context.Service.Shape<typeof ServiceControl> = {
    version: options.version,
    socket: paths.socket,
    startedAt,
    clients: Effect.suspend(() => clients),
    draining: Ref.get(draining),
    stop: (drain) =>
      drain
        ? Ref.set(draining, true).pipe(
            // Release the name first: a newer service can listen while this
            // one finishes its tasks on the connections it already holds.
            Effect.andThen(release),
          )
        : Deferred.succeed(ended, 'stopped').pipe(Effect.asVoid),
  };

  // The socket file's identity: a service that took the path over made a
  // new one.
  const socketIno = fs.stat(paths.socket).pipe(
    Effect.map((info) => Option.getOrUndefined(info.ino)),
    Effect.orElseSucceed(() => undefined),
  );
  const listen = Layer.build(
    RpcServer.layerProtocolSocketServer.pipe(
      Layer.provide(RpcSerialization.layerNdjson),
      Layer.provide(NodeSocketServer.layer({ path: paths.socket })),
    ),
  ).pipe(
    Effect.map((context) => Context.get(context, RpcServer.Protocol)),
    Effect.mapError(
      (cause) => new ServiceListenFailed({ socket: paths.socket, cause }),
    ),
  );
  // Bind without unlinking first: a live service's socket makes the bind
  // fail. Only a socket that refuses connections, and is still the same
  // file after that probe, is a dead service's and is removed; a service
  // that took the path meanwhile keeps it, and this one stops.
  const protocol = yield* listen.pipe(
    Effect.catch((failed) =>
      Effect.gen(function* () {
        const stale = yield* socketIno;
        const answer = yield* probeService(paths.socket);
        if (answer !== null)
          return yield* Effect.fail(
            new ServiceAlreadyRunning({ info: answer }),
          );
        if (stale === undefined || (yield* socketIno) !== stale)
          return yield* Effect.fail(failed);
        // A removal that fails leaves the file, and the bind below reports it.
        yield* fs.remove(paths.socket).pipe(Effect.ignore);
        return yield* listen;
      }),
    ),
  );
  clients = protocol.clientIds.pipe(Effect.map((ids) => ids.size));
  yield* fs
    .chmod(paths.socket, 0o600)
    .pipe(
      Effect.mapError(
        (cause) => new ServiceListenFailed({ socket: paths.socket, cause }),
      ),
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
  const listening = yield* socketIno;
  own = { pid: process.pid, socketIno: listening };
  yield* writeServiceRecord(paths, {
    pid: process.pid,
    protocol: PROTOCOL_VERSION,
    version: options.version,
    socket: paths.socket,
    startedAt,
  }).pipe(
    Effect.mapError(
      (cause) => new ServiceListenFailed({ socket: paths.socket, cause }),
    ),
  );
  yield* Effect.addFinalizer(() => release);
  yield* Effect.logInfo(
    `TeXRA service ${options.version} listening on ${paths.socket}`,
  );

  const idleAfter = Duration.toMillis(options.idleAfter);
  let idleSince: number | null = null;
  const check = Effect.gen(function* () {
    const running = yield* runningTasks(projects);
    const now = yield* Clock.currentTimeMillis;
    if (yield* Ref.get(draining)) {
      if (running === 0) yield* Deferred.succeed(ended, 'drained');
      return;
    }
    // Another service took the socket path over (two started at once):
    // this one can no longer be reached, so it leaves.
    if (listening !== undefined) {
      const current = yield* socketIno;
      if (current !== listening && running === 0) {
        yield* Deferred.succeed(ended, 'replaced');
        return;
      }
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
