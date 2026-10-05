/**
 * A window's side of the service: connect over the socket, say hello, and
 * start the service when none answers. Starting is the host's (each host
 * runs the service entry with its own Node), so {@link ensureService}
 * takes it as a program. A service speaking an older protocol is retired:
 * it drains its running tasks while a new one starts. One speaking a newer
 * protocol is left running and refused, and the caller stays in process.
 */
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';

import * as NodeSocket from '@effect/platform-node/NodeSocket';
import { Data, Effect, Layer, Schedule, type Scope } from 'effect';
import { lt as semverLt, valid as semverValid } from 'semver';
import { RpcClient, RpcSerialization, type RpcClientError } from 'effect/rpc';

import { nodeFileServices } from '@platform/defaults/jsonStore';
import { ensureError } from '@utils/errors/errorMessage';
import { prepareServiceDirectories, servicePaths } from './discovery';

import {
  BUILD_VERSION,
  PROTOCOL_VERSION,
  TexraRpcs,
  type ServiceInfo,
} from './protocol';
import type { SocketError } from 'effect/socket/Socket';

/** The procedures as a client calls them. */
export type ServiceClient = RpcClient.FromGroup<
  typeof TexraRpcs,
  RpcClientError.RpcClientError
>;

/** A connected client and the service it reached. */
export interface ServiceConnection {
  readonly client: ServiceClient;
  readonly info: ServiceInfo;
}

/** No service could be reached or started; the message says why. */
export class ServiceUnavailable extends Data.TaggedError('ServiceUnavailable')<{
  readonly reason: string;
}> {
  override get message(): string {
    return this.reason;
  }
}

/** Why no service runs on Windows yet: a named pipe there takes the
 *  default ACL, which other local users can read and pre-create. */
export const WINDOWS_UNSUPPORTED =
  'The TeXRA service does not run on Windows yet.';

/** How long a started service has to answer its first hello: it loads the
 *  agent catalog first, which a loaded machine makes slow. */
const START_TIMEOUT = '60 seconds';
/** How long a service that accepts the connection may take to say hello. */
const HELLO_TIMEOUT = '10 seconds';

/** A service the caller should retire: an older protocol, or an older
 *  build ({@link BUILD_VERSION}; a development build, `unknown`, never is). */
function isOlder(info: ServiceInfo): boolean {
  if (info.protocol !== PROTOCOL_VERSION)
    return info.protocol < PROTOCOL_VERSION;
  return (
    semverValid(info.version) !== null &&
    semverValid(BUILD_VERSION) !== null &&
    semverLt(info.version, BUILD_VERSION)
  );
}

/** A client over `socket`, held for the caller's scope. Nothing connects
 *  until the first call. */
function connectService(
  socket: string,
): Effect.Effect<ServiceClient, SocketError, Scope.Scope> {
  return Effect.gen(function* () {
    // The protocol lives in the caller's scope, not the client's build: a
    // layer provided to `make` alone would close the socket once it returns.
    const protocol = yield* Layer.build(
      RpcClient.layerProtocolSocket().pipe(
        Layer.provide(NodeSocket.layerNet({ path: socket })),
        Layer.provide(RpcSerialization.layerNdjson),
      ),
    );
    return yield* RpcClient.make(TexraRpcs).pipe(
      Effect.provideContext(protocol),
    );
  });
}

/**
 * The hello of the service on `socket`, or null when nothing accepts the
 * connection (no socket, or a dead service's). A socket that accepts but
 * does not answer in time is a live service too busy or too wedged to say
 * hello: that fails, so no caller mistakes it for a dead one and takes its
 * socket over.
 */
export function probeService(
  socket: string,
): Effect.Effect<ServiceInfo | null, ServiceUnavailable> {
  return Effect.scoped(
    Effect.flatMap(connectService(socket), (client) =>
      client['service.hello']({ protocol: PROTOCOL_VERSION }),
    ),
  ).pipe(
    Effect.timeout(HELLO_TIMEOUT),
    Effect.map((info): ServiceInfo | null => info),
    Effect.catch((error) =>
      (error._tag === 'RpcClientError' || error._tag === 'SocketError') &&
      error.reason._tag === 'SocketOpenError'
        ? Effect.succeed(null)
        : Effect.fail(
            new ServiceUnavailable({
              reason: `The TeXRA service on ${socket} accepts connections but did not answer (${error.message}). Stop it with \`texra service stop\`, or end its process.`,
            }),
          ),
    ),
  );
}

/**
 * Start the service detached, with its output appended to its log, and
 * return at once: the caller waits for its hello. It is detached in its own
 * process group, so it outlives the window that started it. `command` and `args` are
 * the host's: its own Node and entry (the CLI), or its runtime as Node and
 * the shipped headless bundle (`env` `ELECTRON_RUN_AS_NODE=1`).
 */
export function spawnService(
  storageRoot: string,
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const paths = servicePaths(storageRoot);
    yield* prepareServiceDirectories(paths);
    const log = yield* Effect.try({
      try: () => openSync(paths.log, 'a', 0o600),
      catch: ensureError,
    });
    // Settle on the child's own report: an `error` event (no such binary,
    // EACCES, no processes left) fails the start with its cause.
    yield* Effect.callback<void, Error>((resume) => {
      const child = spawn(command, [...args], {
        cwd: paths.runDirectory,
        detached: true,
        stdio: ['ignore', log, log],
        // Only the home directory and TeXRA's own settings: the service
        // reads the rest from the user's login shell, so it never depends
        // on the window that happened to start it.
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              ([name]) => name === 'HOME' || name.startsWith('TEXRA_'),
            ),
          ),
          ...env,
        },
      });
      child.once('error', (error) => resume(Effect.fail(error)));
      child.once('spawn', () => {
        child.unref();
        resume(Effect.void);
      });
    }).pipe(Effect.ensuring(Effect.sync(() => closeSync(log))));
  }).pipe(Effect.mapError(ensureError), Effect.provide(nodeFileServices));
}

/**
 * Ask the service on `socket` to stop now, or to drain (`drain`). It skips
 * the protocol check `ensureService` makes, so an older client can still
 * stop a newer service: `service.stop` keeps its shape across protocols.
 */
export function askServiceToStop(
  socket: string,
  drain: boolean,
): Effect.Effect<void, SocketError | RpcClientError.RpcClientError> {
  return Effect.scoped(
    Effect.flatMap(connectService(socket), (client) =>
      client['service.stop']({ drain }),
    ),
  );
}

/**
 * Connect to this storage root's service, starting it with `start` (which
 * spawns the service detached and returns) when none answers, and retiring
 * one that speaks an older protocol or runs an older build than this one
 * first.
 */
export const ensureService = Effect.fn('server.ensureService')(function* (
  storageRoot: string,
  start: Effect.Effect<void, Error>,
): Effect.fn.Return<ServiceConnection, ServiceUnavailable, Scope.Scope> {
  if (process.platform === 'win32')
    return yield* Effect.fail(
      new ServiceUnavailable({ reason: WINDOWS_UNSUPPORTED }),
    );
  const { socket } = servicePaths(storageRoot);
  let info = yield* probeService(socket);
  if (info !== null && info.protocol > PROTOCOL_VERSION)
    return yield* Effect.fail(
      new ServiceUnavailable({
        reason: `The running TeXRA service (${info.version}, pid ${info.pid}) speaks protocol ${info.protocol}; this TeXRA speaks ${PROTOCOL_VERSION}. Update TeXRA, or stop the service with \`texra service stop\`.`,
      }),
    );
  let retired: number | null = null;
  if (info !== null && isOlder(info)) {
    const retiring = info;
    retired = info.pid;
    yield* Effect.logInfo(
      `Retiring the TeXRA service ${info.version} (protocol ${info.protocol}): it finishes its running tasks and exits.`,
    );
    yield* askServiceToStop(socket, true).pipe(
      Effect.mapError(
        (error) =>
          new ServiceUnavailable({
            reason: `The older TeXRA service (pid ${retiring.pid}) could not be asked to retire: ${error.message}`,
          }),
      ),
    );
    info = null;
  }
  if (info === null) {
    yield* start.pipe(
      Effect.mapError(
        (error) =>
          new ServiceUnavailable({
            reason: `The TeXRA service could not be started: ${error.message}`,
          }),
      ),
    );
    // Not listening yet, listening but still starting, or still the
    // retiring service: all wait for this protocol's own service.
    info = yield* probeService(socket).pipe(
      Effect.flatMap((answer) =>
        answer?.protocol === PROTOCOL_VERSION && answer.pid !== retired
          ? Effect.succeed(answer)
          : Effect.fail(new ServiceUnavailable({ reason: 'not yet up' })),
      ),
      Effect.retry(Schedule.spaced('200 millis')),
      Effect.timeout(START_TIMEOUT),
      Effect.catch(() => Effect.succeed(null)),
    );
  }
  if (info === null)
    return yield* Effect.fail(
      new ServiceUnavailable({
        reason: `The TeXRA service did not answer on ${socket} within ${START_TIMEOUT}.`,
      }),
    );
  const client = yield* connectService(socket).pipe(
    Effect.mapError(
      (error) =>
        new ServiceUnavailable({
          reason: `The TeXRA service on ${socket} could not be reached: ${error.message}`,
        }),
    ),
  );
  return { info, client };
});
