/**
 * A window's side of the service: connect over the socket, say hello, and
 * start the service when none answers. Starting is the host's (each host
 * runs the service entry with its own Node), so {@link ensureService}
 * takes it as a program. One service serves a storage root at a time: a
 * service of an older build, or of another protocol and no newer build, is
 * retired (it drains its running tasks and exits), and the caller waits
 * for its socket to close before starting its own; one already draining
 * is waited for the same way. One of a newer build speaking another
 * protocol is left running and refused, and the caller stays in process.
 */
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { join } from 'node:path';

import * as NodeSocket from '@effect/platform-node/NodeSocket';
import {
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Predicate,
  Ref,
  Schedule,
  Schema,
  Scope,
  Stream,
  SubscriptionRef,
} from 'effect';
import { gt as semverGt, lt as semverLt, valid as semverValid } from 'semver';
import { RpcClient, RpcSerialization, type RpcClientError } from 'effect/rpc';

import { API_KEY_ENV_NAMES } from '@texra-ai/llm';
import { isOutcomeOf } from '@texra-ai/harness';
import {
  ensureError,
  formatResultCount,
  type RuntimeCommand,
  Rejected,
} from '@texra-ai/harness/schemas';
import { nodeFileServices } from '@texra-ai/harness/node';
import {
  prepareServiceDirectories,
  readServiceRecord,
  serviceRecordChanges,
  servicePaths,
} from './discovery';

import {
  BUILD_VERSION,
  PROTOCOL,
  TexraRpcs,
  type ServiceInfo,
} from './protocol';
import type { GlobalValues } from '@texra-ai/harness/host';
import type { SocketError } from 'effect/socket/Socket';

/** The procedures as a client calls them. */
export type ServiceClient = RpcClient.FromGroup<
  typeof TexraRpcs,
  RpcClientError.RpcClientError
>;

/**
 * The provider API keys this process's environment holds, as a start, a
 * resume or a message sends them to the service (`StartOptions.apiKeys`): a
 * key a terminal or a window was given reaches the task it asks for,
 * wherever the task runs.
 */
export const environmentApiKeys = (): Readonly<Record<string, string>> =>
  Object.fromEntries(
    API_KEY_ENV_NAMES.flatMap((name) => {
      const value = process.env[name]?.trim();
      return value ? [[name, value]] : [];
    }),
  );

/**
 * `request` to the session of `workspace` the service holds: the outcome its
 * kind is answered with. A message carries this process's keys, which the
 * run resumes with if the message wakes it. An answer of another kind (a
 * service from another build) is `Rejected`.
 */
export const requestOnService = <R extends RuntimeCommand>(
  client: ServiceClient,
  workspace: string,
  request: R,
) =>
  client['task.request']({
    workspace,
    request:
      request.kind === 'followUp.send'
        ? { ...request, apiKeys: request.apiKeys ?? environmentApiKeys() }
        : request,
  }).pipe(
    Effect.filterOrFail(
      (outcome) => isOutcomeOf<R['kind']>(request.kind, outcome),
      (outcome) =>
        new Rejected({
          reason: `The TeXRA service answered a ${request.kind} with ${outcome.kind}.`,
        }),
    ),
  );

/** A connected client and the service it reached. */
export interface ServiceConnection {
  readonly client: ServiceClient;
  readonly info: ServiceInfo;
}

/** No service could be reached or started; the message says why. */
export class ServiceUnavailable extends Schema.TaggedError<ServiceUnavailable>()(
  'ServiceUnavailable',
  {
    reason: Schema.String,

    /** The running service is a newer build speaking another protocol: it
     *  stays until it exits, so waiting does not bring this client back. */
    newer: Schema.optional(Schema.Literal(true)),
    /** The running service answered the hello with something this build
     *  cannot read, or refused the hello itself: a build from before the
     *  digest. Its socket, for the one procedure every build keeps,
     *  `service.stop`. */
    unspoken: Schema.optional(Schema.String),
    /** The running service accepted the connection and did not answer the
     *  hello within its deadline. */
    unanswered: Schema.optional(Schema.Literal(true)),
  },
) {
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
export const START_TIMEOUT = '60 seconds';
/** A started service's probe before it answers this protocol. */
const NOT_YET_UP = 'not yet up';
/** How long a service that accepts the connection may take to say hello. */
const HELLO_TIMEOUT = '10 seconds';

/** Whether the service speaks this build's protocol ({@link PROTOCOL}). */
export const compatible = (info: ServiceInfo): boolean =>
  info.protocol === PROTOCOL.digest;

/** Whether both builds are released ones, and `order` holds between the
 *  service's and this one ({@link BUILD_VERSION}; a development build,
 *  `unknown`, is neither older nor newer). */
const builds = (
  info: ServiceInfo,
  order: (service: string, own: string) => boolean,
): boolean =>
  semverValid(info.version) !== null &&
  semverValid(BUILD_VERSION) !== null &&
  order(info.version, BUILD_VERSION);

/** A service of a newer build speaking another protocol: left running,
 *  and this client refused. */
export const isNewer = (info: ServiceInfo): boolean =>
  !compatible(info) && builds(info, semverGt);

/** A service the caller should retire: an older build, or one of another
 *  protocol that is not a newer build (a development build restarts the
 *  service it cannot speak to). */
export const isOlder = (info: ServiceInfo): boolean =>
  builds(info, semverLt) || (!compatible(info) && !isNewer(info));

/** A client over `socket`, held for the caller's scope. `onDisconnect`
 *  runs whenever the connection ends, or an attempt to open it fails. */
const connectService = Effect.fn('connectService')(function* (
  socket: string,
  onDisconnect: Effect.Effect<void> = Effect.void,
): Effect.fn.Return<ServiceClient, SocketError, Scope.Scope> {
  // The protocol lives in the caller's scope, not the client's build: a
  // layer provided to `make` alone would close the socket once it returns.
  const protocol = yield* Layer.build(
    RpcClient.layerProtocolSocket().pipe(
      Layer.provide(NodeSocket.layerNet({ path: socket })),
      Layer.provide(RpcSerialization.layerNdjson),
      Layer.provide(
        Layer.succeed(RpcClient.ConnectionHooks, {
          onConnect: Effect.void,
          onDisconnect,
        }),
      ),
    ),
  );
  return yield* RpcClient.make(TexraRpcs).pipe(Effect.provideContext(protocol));
});

/** Nothing accepts a connection on the socket: no service, or a dead one. */
const nobodyListens = (error: {
  readonly _tag: string;
  readonly reason?: { readonly _tag: string };
}) =>
  (error._tag === 'RpcClientError' || error._tag === 'SocketError') &&
  error.reason?._tag === 'SocketOpenError';

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
      client['service.hello']({ protocol: PROTOCOL.digest }),
    ),
  ).pipe(
    Effect.timeout(HELLO_TIMEOUT),
    Effect.map((info): ServiceInfo | null => info),
    Effect.catch((error) =>
      nobodyListens(error)
        ? Effect.succeed(null)
        : error._tag === 'TimeoutError'
          ? Effect.fail(
              new ServiceUnavailable({
                reason: `The TeXRA service on ${socket} accepts connections but did not answer (${error.message}). Stop it with \`texra service stop\`, or end its process.`,
                unanswered: true,
              }),
            )
          : Effect.fail(
              new ServiceUnavailable({
                reason: `The TeXRA service on ${socket} speaks a protocol this build cannot read (${error.message}).`,
                unspoken: socket,
              }),
            ),
    ),
  );
}

/**
 * The hello of the service the storage root's record names, or null when
 * there is none: no record, or a socket nobody accepts on (a service that
 * died).
 */
export const probeRecordedService: Effect.Effect<
  ServiceInfo | null,
  ServiceUnavailable,
  GlobalValues
> = readServiceRecord.pipe(
  Effect.mapError(
    (error) =>
      new ServiceUnavailable({
        reason: `The service record could not be read: ${error.message}`,
      }),
  ),
  Effect.flatMap((record) =>
    record === null ? Effect.succeed(null) : probeService(record.socket),
  ),
);

/**
 * How a host starts the service of a storage root: the root, whose
 * `serve.log` is where a service that never answers is explained, and the
 * start itself.
 */
interface ServiceStart {
  readonly storageRoot: string;
  /** Spawns the service detached and returns; the caller waits for its
   *  hello. */
  readonly start: Effect.Effect<void, Error>;
}

/**
 * The start of the service that runs detached, with its output appended to
 * its log, and returns at once: the caller waits for its hello. It is
 * detached in its own process group, so it outlives the window that started
 * it. `command` and `args` are the host's: its own Node and entry (the CLI),
 * or its runtime as Node and the shipped headless bundle (`env`
 * `ELECTRON_RUN_AS_NODE=1`).
 */
export function spawnService(
  storageRoot: string,
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): ServiceStart {
  const paths = servicePaths(storageRoot);
  const start = Effect.gen(function* () {
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
          // Node's on-disk compile cache, in the private run directory: a
          // start after the first skips most of compiling the 12 MB bundle
          // (~250 ms). A runtime without the cache ignores the variable.
          NODE_COMPILE_CACHE: join(paths.runDirectory, 'compile-cache'),
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
  return { storageRoot, start };
}

/**
 * Ask the service on `socket` to stop (now, or once its running tasks end
 * with `drain`) and wait until it is gone. The answer is the socket closing
 * under this connection: the service exits ahead of any response, so the
 * ask is sent without awaiting one (`discard`: it completes as the handler
 * starts). A socket nobody accepts on is a service already gone.
 */
export const stopService = (
  socket: string,
  drain: boolean,
): Effect.Effect<void, SocketError | RpcClientError.RpcClientError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const gone = yield* Deferred.make<void>();
      const client = yield* connectService(
        socket,
        Effect.asVoid(Deferred.succeed(gone, undefined)),
      );
      yield* client['service.stop']({ drain }, { discard: true });
      yield* Deferred.await(gone);
    }),
  ).pipe(Effect.catchIf(nobodyListens, () => Effect.void));

/** The refusal of a running service of a newer build that speaks another
 *  protocol. */
const newerService = (info: ServiceInfo) =>
  new ServiceUnavailable({
    reason: `The running TeXRA service (${info.version}, pid ${info.pid}) is newer than this TeXRA (${BUILD_VERSION}) and speaks another protocol. Update TeXRA, or stop the service with \`texra service stop\`.`,
    newer: true,
  });

/**
 * Connect to the service of `start`'s storage root, starting it with
 * `start` when none answers. One that speaks an older protocol or runs an
 * older build than this one is retired first, and one already draining
 * waited for: either exits once its tasks end, and its socket's close is
 * the signal to start.
 */
export const ensureService = Effect.fn('server.ensureService')(function* (
  { storageRoot, start }: ServiceStart,
  options: {
    /** Runs whenever the connection ends (see {@link connectService}). */
    readonly onDisconnect?: Effect.Effect<void>;
    /** Told, once, when an older or draining service must exit first: the
     *  wait lasts until its running tasks end. */
    readonly waiting: (message: string) => Effect.Effect<void>;
  },
): Effect.fn.Return<
  ServiceConnection,
  ServiceUnavailable,
  Scope.Scope | GlobalValues
> {
  if (process.platform === 'win32')
    return yield* new ServiceUnavailable({ reason: WINDOWS_UNSUPPORTED });
  // A service from before the digest cannot read this hello: it is older
  // by construction, and `service.stop` is the one procedure it shares.
  let info = yield* probeRecordedService.pipe(
    Effect.catchIf(
      (error) => error.unspoken !== undefined,
      (error) =>
        options
          .waiting(
            "Retiring a TeXRA service that speaks a protocol this build cannot read; it finishes its tasks and exits, then this build's starts.",
          )
          .pipe(
            Effect.andThen(
              stopService(error.unspoken ?? '', true).pipe(
                Effect.mapError(
                  (failure) =>
                    new ServiceUnavailable({
                      reason: `The older TeXRA service could not be asked to retire: ${failure.message}`,
                    }),
                ),
              ),
            ),
            Effect.as(null),
          ),
    ),
  );
  if (info !== null && isNewer(info))
    return yield* Effect.fail(newerService(info));
  if (info !== null && (isOlder(info) || info.draining)) {
    const leaving = info;
    const tasks = formatResultCount(leaving.running, 'running task');
    // With no task running it exits at once: nothing to wait for.
    yield* (leaving.running > 0 ? options.waiting : Effect.logInfo)(
      leaving.draining
        ? `The TeXRA service ${leaving.version} (pid ${leaving.pid}) is finishing its ${tasks} before it exits; waiting for it.`
        : `Retiring the TeXRA service ${leaving.version} (protocol ${leaving.protocol}): it finishes its ${tasks} and exits, then this build's starts.`,
    );
    yield* stopService(leaving.socket, true).pipe(
      Effect.mapError(
        (error) =>
          new ServiceUnavailable({
            reason: `The older TeXRA service (pid ${leaving.pid}) could not be asked to retire: ${error.message}`,
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
    // The service claims the record once it listens, so the record's
    // changes are the signal to probe on: not claimed yet waits for the
    // next change, a claimed one whose hello is not answered in time (a
    // service still coming up under load) is asked again while the start
    // window lasts, and a newer build's service that came up meanwhile
    // refuses this one at once. Past the deadline, the last probe's reason
    // stands; only "not yet up" reads as the service not answering.
    const lastRefusal = yield* Ref.make(
      new ServiceUnavailable({ reason: NOT_YET_UP }),
    );
    const probed = probeRecordedService.pipe(
      Effect.retry({ while: (error) => error.unanswered === true }),
      Effect.flatMap((answer) => {
        if (answer !== null && isNewer(answer))
          return Effect.fail(newerService(answer));
        return answer !== null && compatible(answer) && !answer.draining
          ? Effect.succeed(answer)
          : Effect.fail(new ServiceUnavailable({ reason: NOT_YET_UP }));
      }),
      Effect.tapError((refusal) => Ref.set(lastRefusal, refusal)),
      Effect.catchIf(
        (error) => error.newer !== true,
        () => Effect.succeed(null),
      ),
    );
    info = yield* serviceRecordChanges.pipe(
      Stream.mapEffect(() => probed),
      Stream.filter(Predicate.isNotNull),
      Stream.runHead,
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.flatMap(Ref.get(lastRefusal), Effect.fail),
          onSome: Effect.succeed,
        }),
      ),
      Effect.timeoutOrElse({
        duration: START_TIMEOUT,
        orElse: () => Effect.flatMap(Ref.get(lastRefusal), Effect.fail),
      }),
      Effect.mapError((error) =>
        error.reason === NOT_YET_UP
          ? new ServiceUnavailable({
              reason: `The TeXRA service did not answer within ${START_TIMEOUT} (its log: ${servicePaths(storageRoot).log}).`,
            })
          : error,
      ),
    );
  }
  const { socket } = info;
  const client = yield* connectService(socket, options.onDisconnect).pipe(
    Effect.mapError(
      (error) =>
        new ServiceUnavailable({
          reason: `The TeXRA service on ${socket} could not be reached: ${error.message}`,
        }),
    ),
  );
  return { info, client };
});

/** What a call made while the link reconnects is told. */
const SERVICE_OFFLINE =
  'The TeXRA service is offline; TeXRA is reconnecting to it.';

/** What a window is told when a newer TeXRA's service replaced the one it
 *  spoke to: it cannot reconnect until it is reloaded or updated. */
export const WINDOW_OUTDATED =
  'This window is older than the running TeXRA service; reload or update TeXRA.';

/** A value as its readers follow it: what it is now, and each value from
 *  the current one on. */
export interface Followed<A> {
  readonly get: Effect.Effect<A>;
  readonly changes: Stream.Stream<A>;
}

/** `ref` as its readers follow it; only its holder sets it. */
export const followed = <A>(
  ref: SubscriptionRef.SubscriptionRef<A>,
): Followed<A> => ({
  get: SubscriptionRef.get(ref),
  changes: SubscriptionRef.changes(ref),
});

/** A window's lasting hold on the service: the client it is connected
 *  through, or null while the service is away and the link reaches it
 *  again; and, while it is null, why. A window of a session its own
 *  process opened holds a link to that process (`HostWindows.localLink`),
 *  whose client is only what a window attaches through: a link to the
 *  service is one of those too. */
export interface ServiceLink<Client = ServiceClient> {
  readonly client: Followed<Client | null>;
  /** Why `client` is null, as a window says it: reconnecting
   *  ({@link SERVICE_OFFLINE}), or refused by a newer service
   *  ({@link WINDOW_OUTDATED}). */
  readonly away: SubscriptionRef.SubscriptionRef<string>;
  /** Whether a window was told of the refusal `away` holds: once per
   *  link, however many projects' windows attached through it. */
  readonly refusalTold: Ref.Ref<boolean>;
}

/** Why `link` holds no service now, at each change: its `away` while its
 *  client is null, null while it holds one. What a window's banner says. */
export const linkOutage = (
  link: ServiceLink<unknown>,
): Stream.Stream<string | null> =>
  Stream.merge(link.client.changes, SubscriptionRef.changes(link.away)).pipe(
    Stream.mapEffect(() =>
      Effect.map(
        Effect.all([link.client.get, SubscriptionRef.get(link.away)]),
        ([client, away]) => (client === null ? away : null),
      ),
    ),
    Stream.changes,
  );

/** Between attempts to reach a service that went away: from half a second,
 *  growing, never more than ten seconds apart. */
const RECONNECT = Schedule.min([
  Schedule.exponential('500 millis'),
  Schedule.spaced('10 seconds'),
]);

/**
 * Hold this storage root's service for the caller's scope, as
 * {@link ensureService} reaches it. When the service goes away (a newer
 * build retired it, or it died), the link goes null, which a window shows
 * as offline, and reaches the service again the same way, starting one
 * when none answers, until it is back. A first reach that must wait for an
 * older service to finish its tasks says so through `waiting`, the host's
 * way to tell its user; a later one says it as the link's `away`.
 */
export const linkService = Effect.fn('server.linkService')(function* (
  start: ServiceStart,
  waiting: (message: string) => Effect.Effect<void>,
): Effect.fn.Return<
  ServiceLink,
  ServiceUnavailable,
  Scope.Scope | GlobalValues
> {
  const away = yield* SubscriptionRef.make(SERVICE_OFFLINE);
  const connect = Effect.fn('connect')(function* (
    begin: ServiceStart,
    told: (message: string) => Effect.Effect<void>,
  ) {
    const scope = yield* Scope.make();
    const lost = yield* Deferred.make<void>();
    const connection = yield* ensureService(begin, {
      onDisconnect: Effect.asVoid(Deferred.succeed(lost, undefined)),
      waiting: told,
    }).pipe(
      Scope.provide(scope),
      Effect.onError(() => Scope.close(scope, Exit.void)),
    );
    return { connection, lost, scope };
  });
  let current = yield* connect(start, waiting);
  const client = yield* SubscriptionRef.make<ServiceClient | null>(
    current.connection.client,
  );
  // While the link is down, a wait on an older service is what the
  // window's banner says.
  const awayWaiting = (message: string) =>
    SubscriptionRef.set(away, message).pipe(
      Effect.andThen(Effect.logWarning(message)),
    );
  const refusalTold = yield* Ref.make(false);
  yield* Effect.addFinalizer(() =>
    Effect.suspend(() => Scope.close(current.scope, Exit.void)),
  );
  yield* Effect.forkScoped(
    Effect.forever(
      Effect.gen(function* () {
        yield* Deferred.await(current.lost);
        yield* SubscriptionRef.set(away, SERVICE_OFFLINE);
        yield* SubscriptionRef.set(client, null);
        yield* Scope.close(current.scope, Exit.void);
        yield* Effect.logWarning(
          `The TeXRA service (pid ${current.connection.info.pid}) went away; reconnecting.`,
        );
        // A newer build that retired the service is starting its own: the
        // link waits the whole startup window for one to answer, so an
        // older window never races it with one of its build, and starts
        // one itself only when none came, as at startup.
        let told = '';
        current = yield* connect(
          { storageRoot: start.storageRoot, start: Effect.void },
          awayWaiting,
        ).pipe(
          Effect.catch(() => connect(start, awayWaiting)),
          // Said once per reason: a newer protocol's service stays until it
          // exits, and the link keeps trying meanwhile.
          Effect.tapError((error) =>
            Effect.suspend(() => {
              if (error.message === told) return Effect.void;
              told = error.message;
              return SubscriptionRef.set(
                away,
                error.newer === true ? WINDOW_OUTDATED : SERVICE_OFFLINE,
              ).pipe(
                Effect.andThen(
                  Effect.logWarning(
                    `The TeXRA service is not back yet: ${error.message}`,
                  ),
                ),
              );
            }),
          ),
          // RECONNECT never ends, so the retry never fails.
          Effect.retry(RECONNECT),
          Effect.orDie,
        );
        yield* Effect.logInfo(
          `Reconnected to the TeXRA service ${current.connection.info.version} (pid ${current.connection.info.pid}).`,
        );
        // Reached again: whatever kept it away no longer holds, so a host
        // that attaches later is not told it, and a later refusal is told.
        yield* SubscriptionRef.set(away, SERVICE_OFFLINE);
        yield* Ref.set(refusalTold, false);
        yield* SubscriptionRef.set(client, current.connection.client);
      }),
    ),
  );
  return { client: followed(client), away, refusalTold };
});
