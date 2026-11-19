/**
 * A client's side of the service, for every host: connect over the socket,
 * say hello, and start the service when none answers. Starting is the
 * host's (each host runs the service entry with its own Node), so
 * {@link linkService} takes it as a program. No service is possible where
 * `TEXRA_NO_SERVICE` is set or on Windows, which the link answers as it
 * answers none running for a caller that starts none. One service serves a storage root at a time: a
 * service of an older build, or of another protocol and no newer build, is
 * retired (it drains its running tasks and exits), and the caller waits
 * for its socket to close before starting its own; one already draining
 * is waited for the same way. One of a newer build speaking another
 * protocol is left running and refused, and the caller stays in process.
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { join } from 'node:path';

import * as NodeSocket from '@effect/platform-node/NodeSocket';
import {
  Clock,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Predicate,
  Ref,
  Result,
  Schedule,
  Schema,
  Scope,
  SemVer,
  Stream,
  SubscriptionRef,
} from 'effect';
import { RpcClient, RpcSerialization, type RpcClientError } from 'effect/rpc';

import { API_KEY_ENV_NAMES } from '@texra-ai/llm';
import { isOutcomeOf } from '@texra-ai/harness';
import {
  formatResultCount,
  type RuntimeCommand,
  Rejected,
  ensureError,
} from '@texra-ai/harness/schemas';
import { envFlag, nodeFileServices } from '@texra-ai/harness/node';
import {
  prepareServiceDirectories,
  readServiceRecord,
  SERVICE_SUBCOMMAND,
  serviceRecordChanges,
  servicePaths,
} from './discovery';

import {
  BUILD_VERSION,
  PROTOCOL,
  TexraRpcs,
  type ServiceInfo,
  type TaskSummary,
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
 * resume or a message sends them to the service (`StartInput.apiKeys`): a
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

/**
 * The task `id` names among every task the service holds: its full id, or
 * a prefix only one task has. Answers that task, or else every task the
 * prefix matches: none, or more than one.
 */
export const findTask = (
  client: ServiceClient,
  id: string,
): Effect.Effect<
  { readonly task: TaskSummary } | { readonly matches: readonly TaskSummary[] },
  RpcClientError.RpcClientError
> =>
  Effect.map(client['tasks.list']({ all: true }), (tasks) => {
    const exact = tasks.find((task) => task.runId === id);
    const matches = exact
      ? [exact]
      : tasks.filter((task) => task.runId.startsWith(id));
    return matches.length === 1 ? { task: matches[0] } : { matches };
  });

/** A connected client and the service it reached. */
export interface ServiceConnection {
  readonly client: ServiceClient;
  readonly info: ServiceInfo;
}

/** Why no service could be reached, for the callers that act on it;
 *  `failed` for every other reason, which a caller only reports. */
const ServiceFailureSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('failed') }),
  /** No service for this process, and nothing failed: none is possible
   *  here (`TEXRA_NO_SERVICE`, Windows), or none runs and the caller starts
   *  none. A caller that works in process has nothing more to say. */
  Schema.Struct({ kind: Schema.Literal('none') }),
  /** The running service is a newer build speaking another protocol: it
   *  stays until it exits, so waiting does not bring this client back. */
  Schema.Struct({ kind: Schema.Literal('newer') }),
  /** The running service answered the hello with something this build
   *  cannot read, or refused the hello itself: a build from before the
   *  digest. Its socket, for the one procedure every build keeps,
   *  `service.stop`. */
  Schema.Struct({
    kind: Schema.Literal('unreadable'),
    socket: Schema.String,
  }),
  /** The running service accepted the connection and did not answer the
   *  hello within its deadline. */
  Schema.Struct({ kind: Schema.Literal('unanswered') }),
  /** A start that left no service: it could not be spawned, it exited
   *  abnormally, nothing answered this protocol within the start window
   *  (no record, or one naming a service still coming up or draining), or
   *  one answered and went away again within that window. What the link's
   *  restarts are limited by ({@link RESTARTS}). */
  Schema.Struct({ kind: Schema.Literal('startFailed') }),
]);

/** No service could be reached or started; the message says why. */
export class ServiceUnavailable extends Schema.TaggedError<ServiceUnavailable>()(
  'ServiceUnavailable',
  {
    reason: Schema.String,
    failure: ServiceFailureSchema.pipe(
      Schema.withConstructorDefault(Effect.succeed({ kind: 'failed' })),
    ),
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

/** `TEXRA_NO_SERVICE=1`: this process uses no background service, and
 *  runs its tasks itself, as where the service cannot run. */
const NO_SERVICE = 'TEXRA_NO_SERVICE';

/** Why a caller that starts no service holds none. */
const NONE_RUNNING = 'no TeXRA service is running';

/** How long a started service has to answer its first hello: it loads the
 *  agent catalog first, which a loaded machine makes slow. */
const START_TIMEOUT = '60 seconds';
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
  order: (service: SemVer.SemVer, own: SemVer.SemVer) => boolean,
): boolean => {
  const service = SemVer.parse(info.version);
  const own = SemVer.parse(BUILD_VERSION);
  return (
    Result.isSuccess(service) &&
    Result.isSuccess(own) &&
    order(service.success, own.success)
  );
};

/** A service of a newer build speaking another protocol: left running,
 *  and this client refused. */
const isNewer = (info: ServiceInfo): boolean =>
  !compatible(info) && builds(info, SemVer.isGreaterThan);

/** A service the caller should retire: an older build, or one of another
 *  protocol that is not a newer build (a development build restarts the
 *  service it cannot speak to). */
const isOlder = (info: ServiceInfo): boolean =>
  builds(info, SemVer.isLessThan) || (!compatible(info) && !isNewer(info));

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
                failure: { kind: 'unanswered' },
              }),
            )
          : Effect.fail(
              new ServiceUnavailable({
                reason: `The TeXRA service on ${socket} speaks a protocol this build cannot read (${error.message}).`,
                failure: { kind: 'unreadable', socket },
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

/** The service's process could not be started: its directories or log
 *  could not be prepared, or the spawn itself failed. */
class ServiceStartFailed extends Schema.TaggedError<ServiceStartFailed>()(
  'ServiceStartFailed',
  { message: Schema.String, cause: Schema.Defect() },
) {}

const startFailed = (cause: unknown) =>
  new ServiceStartFailed({ message: ensureError(cause).message, cause });

/**
 * How a host starts the service of a storage root: the root, whose
 * `serve.log` is where a service that never answers is explained, and the
 * start itself.
 */
interface ServiceStart {
  readonly storageRoot: string;
  /** Spawns the service detached and returns; the caller waits for its
   *  hello. Answers the started process's abnormal end: an effect that
   *  finishes, with how it ended, only if the process exits with an error
   *  or on a signal (one that exits clean lost a start race to another
   *  service, which the record names). */
  readonly start: Effect.Effect<Effect.Effect<string>, Error>;
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
      catch: startFailed,
    });
    // Finish on the child's own report: an `error` event (no such binary,
    // EACCES, no processes left) fails the start with its cause.
    return yield* Effect.callback<Effect.Effect<string>, ServiceStartFailed>(
      (resume) => {
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
        child.once('error', (error) => resume(Effect.fail(startFailed(error))));
        const crashed = Deferred.makeUnsafe<string>();
        child.once('exit', (code, signal) => {
          if (code !== 0)
            Deferred.doneUnsafe(
              crashed,
              Effect.succeed(
                signal === null
                  ? `exited with code ${code}`
                  : `was ended by ${signal}`,
              ),
            );
        });
        child.once('spawn', () => {
          child.unref();
          resume(Effect.succeed(Deferred.await(crashed)));
        });
      },
    ).pipe(Effect.ensuring(Effect.sync(() => closeSync(log))));
  }).pipe(
    Effect.catchTag('PlatformError', (error) =>
      Effect.fail(startFailed(error)),
    ),
    Effect.provide(nodeFileServices),
  );
  return { storageRoot, start };
}

/**
 * Hold the service of `storageRoot` for the caller's scope, as
 * {@link linkService} does, starting it when none answers from the headless
 * bundle a GUI host ships under `resourcesRoot` (`serve/texra-serve.mjs`),
 * run with the host's own Electron as Node. A build without the bundle fails,
 * naming where it looked.
 */
export const reachBundledService = (
  storageRoot: string,
  resourcesRoot: string,
): Effect.Effect<ServiceLink, ServiceUnavailable, Scope.Scope | GlobalValues> =>
  Effect.suspend(() => {
    const bundle = join(resourcesRoot, 'serve', 'texra-serve.mjs');
    if (!existsSync(bundle))
      return Effect.fail(
        new ServiceUnavailable({
          reason: `this build has no service bundle at ${bundle}`,
        }),
      );
    return linkService(
      spawnService(
        storageRoot,
        process.execPath,
        [bundle, SERVICE_SUBCOMMAND],
        {
          ELECTRON_RUN_AS_NODE: '1',
        },
      ),
      { startsService: true, waiting: Effect.logWarning },
    );
  });

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

/** How long {@link stopRunningService} waits for the service to go. */
const STOP_TIMEOUT = '30 seconds';

/**
 * Stop the storage root's service and wait until it is gone, within
 * {@link STOP_TIMEOUT}: its running tasks stop, and can be resumed. A
 * service this build cannot speak to still takes the stop, the one
 * procedure every build keeps. Answers the stopped service's pid (absent
 * when this build could not read its hello), or null when none ran.
 */
export const stopRunningService: Effect.Effect<
  { readonly pid?: number } | null,
  ServiceUnavailable,
  GlobalValues
> = Effect.gen(function* () {
  // A service this build cannot speak to: its socket is all this build
  // knows of it.
  const target:
    | (Pick<ServiceInfo, 'socket'> & { readonly pid?: number })
    | null = yield* probeRecordedService.pipe(
    Effect.catch((error) => {
      const { failure } = error;
      return failure.kind === 'unreadable'
        ? Effect.succeed({ socket: failure.socket })
        : Effect.fail(error);
    }),
  );
  if (target === null) return null;
  const service =
    target.pid === undefined
      ? 'the TeXRA service'
      : `the TeXRA service (pid ${target.pid})`;
  yield* stopService(target.socket, false).pipe(
    Effect.timeoutOrElse({
      duration: STOP_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new ServiceUnavailable({
            reason: `it did not exit within ${STOP_TIMEOUT}`,
          }),
        ),
    }),
    Effect.mapError(
      (failure) =>
        new ServiceUnavailable({
          reason: `Could not stop ${service}: ${failure.message}`,
        }),
    ),
  );
  return target.pid === undefined ? {} : { pid: target.pid };
});

/** The refusal of a running service of a newer build that speaks another
 *  protocol. */
const newerService = (info: ServiceInfo) =>
  new ServiceUnavailable({
    reason: `The running TeXRA service (${info.version}, pid ${info.pid}) is newer than this TeXRA (${BUILD_VERSION}) and speaks another protocol. Update TeXRA, or stop the service with \`texra service stop\`.`,
    failure: { kind: 'newer' },
  });

/** How a caller links: whether it starts a service when none runs (a
 *  window, or a command that runs or lists tasks), and how it tells its
 *  user that the link waits on an older or draining service. */
interface LinkPolicy {
  readonly startsService: boolean;
  /** Told, once, when an older or draining service must exit first: the
   *  wait lasts until its running tasks end. */
  readonly waiting: (message: string) => Effect.Effect<void>;
}

/**
 * Connect to the service of `start`'s storage root, starting it with
 * `start` when none answers and the caller `startsService`. One that speaks
 * an older protocol or runs an older build than this one is retired first,
 * and one already draining waited for: either exits once its tasks end, and
 * its socket's close is the signal to start. An older build's service holds
 * the projects it serves, and a project store is held by one process, so a
 * client that retires one starts its own in its place whether or not it
 * `startsService`.
 */
const ensureService = Effect.fn('server.ensureService')(function* (
  { storageRoot, start }: ServiceStart,
  { startsService, waiting }: LinkPolicy,
  /** Runs whenever the connection ends (see {@link connectService}). */
  onDisconnect: Effect.Effect<void>,
): Effect.fn.Return<
  ServiceConnection,
  ServiceUnavailable,
  Scope.Scope | GlobalValues
> {
  // A service from before the digest cannot read this hello: it is older
  // by construction, and `service.stop` is the one procedure it shares.
  const probed = yield* probeRecordedService.pipe(
    Effect.map((found) => ({ found, replaced: false })),
    Effect.catch((error) => {
      const { failure } = error;
      return failure.kind !== 'unreadable'
        ? Effect.fail(error)
        : waiting(
            "Retiring a TeXRA service that speaks a protocol this build cannot read; it finishes its tasks and exits, then this build's starts.",
          ).pipe(
            Effect.andThen(
              stopService(failure.socket, true).pipe(
                Effect.mapError(
                  (stopFailure) =>
                    new ServiceUnavailable({
                      reason: `The older TeXRA service could not be asked to retire: ${stopFailure.message}`,
                    }),
                ),
              ),
            ),
            Effect.as({ found: null, replaced: true }),
          );
    }),
  );
  let info: ServiceInfo | null = probed.found;
  // Whether this client retired an older service, and so starts its own.
  let { replaced } = probed;
  if (info !== null && isNewer(info)) return yield* newerService(info);
  if (info !== null && (isOlder(info) || info.draining)) {
    const leaving = info;
    replaced = isOlder(leaving);
    const tasks = formatResultCount(leaving.running, 'running task');
    // With no task running it exits at once: nothing to wait for.
    yield* (leaving.running > 0 ? waiting : Effect.logInfo)(
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
  if (info === null && !replaced && !startsService)
    return yield* new ServiceUnavailable({
      reason: NONE_RUNNING,
      failure: { kind: 'none' },
    });
  if (info === null) {
    const { log } = servicePaths(storageRoot);
    const crashed = yield* start.pipe(
      Effect.mapError(
        (error) =>
          new ServiceUnavailable({
            reason: `The TeXRA service could not be started: ${error.message}`,
            failure: { kind: 'startFailed' },
          }),
      ),
    );
    // The service claims the record once it listens, so the record's
    // changes are the signal to probe on: not claimed yet waits for the
    // next change, a claimed one whose hello is not answered in time (a
    // service still coming up under load) is asked again while the start
    // window lasts, and a newer build's service that came up meanwhile
    // refuses this one at once. Past the deadline, the last probe's reason
    // stands; only "not yet up" reads as the start having failed.
    const notYetUp = new ServiceUnavailable({
      reason: `The TeXRA service did not answer within ${START_TIMEOUT} (its log: ${log}).`,
      failure: { kind: 'startFailed' },
    });
    const lastRefusal = yield* Ref.make(notYetUp);
    const probed = probeRecordedService.pipe(
      Effect.retry({ while: (error) => error.failure.kind === 'unanswered' }),
      Effect.flatMap((answer) => {
        if (answer !== null && isNewer(answer))
          return Effect.fail(newerService(answer));
        return answer !== null && compatible(answer) && !answer.draining
          ? Effect.succeed(answer)
          : Effect.fail(notYetUp);
      }),
      Effect.tapError((refusal) => Ref.set(lastRefusal, refusal)),
      Effect.catchIf(
        (error) => error.failure.kind !== 'newer',
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
      // The started process ending abnormally fails the start at once.
      Effect.raceFirst(
        Effect.flatMap(crashed, (how) =>
          Effect.fail(
            new ServiceUnavailable({
              reason: `The TeXRA service ${how} before it answered (its log: ${log}).`,
              failure: { kind: 'startFailed' },
            }),
          ),
        ),
      ),
    );
  }
  const { socket } = info;
  const client = yield* connectService(socket, onDisconnect).pipe(
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
export const SERVICE_OFFLINE =
  'The TeXRA service is offline; TeXRA is reconnecting to it.';

/** What a window is told when a newer TeXRA's service replaced the one it
 *  spoke to: it cannot reconnect until it is reloaded or updated. */
export const WINDOW_OUTDATED =
  'This window is older than the running TeXRA service; reload or update TeXRA.';

/** A value as its readers follow it: what it is now, and each value from
 *  the current one on. */
interface Followed<A> {
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

/** What a link holds: the client it is connected through, or none and
 *  why, as a window says it: reconnecting ({@link SERVICE_OFFLINE}),
 *  refused by a newer service ({@link WINDOW_OUTDATED}), or given up on a
 *  service that keeps failing to start. `lasting`: waiting on the link
 *  does not bring the service back, so whoever waits is told `away`
 *  instead (a newer service stays until it exits; a link that gave up
 *  starts no more). */
export type Linked<Client> =
  | { readonly client: Client }
  | {
      readonly client: null;
      readonly away: string;
      readonly lasting: boolean;
    };

/** A window's lasting hold on the service: one value, set by the link's
 *  holder alone, which goes away while the service is and comes back as
 *  the link reaches it again. A window of a session its own process opened
 *  holds a link to that process (`HostWindows.localLink`), whose client is
 *  only what a window attaches through: a link to the service is one of
 *  those too. */
export interface ServiceLink<Client = ServiceClient> {
  readonly state: Followed<Linked<Client>>;
  /** The client of `state`, null while it holds none. */
  readonly client: Followed<Client | null>;
  /** Whether a window was told of the refusal the link is away for: once
   *  per link, however many projects' windows attached through it. */
  readonly refusalTold: Ref.Ref<boolean>;
}

/** A link over the one value its holder sets. */
export const linkOver = <Client>(
  state: SubscriptionRef.SubscriptionRef<Linked<Client>>,
  refusalTold: Ref.Ref<boolean>,
): ServiceLink<Client> => ({
  state: followed(state),
  client: {
    get: Effect.map(SubscriptionRef.get(state), ({ client }) => client),
    changes: SubscriptionRef.changes(state).pipe(
      Stream.map(({ client }) => client),
      Stream.changes,
    ),
  },
  refusalTold,
});

/** The service's client through `link` now; a link that holds none fails
 *  with why. A reconnect needs nothing of the caller: its next call takes
 *  it. */
export const linkedClient = <Client>(
  link: ServiceLink<Client>,
): Effect.Effect<Client, ServiceUnavailable> =>
  Effect.flatMap(link.state.get, (state) =>
    'away' in state
      ? Effect.fail(new ServiceUnavailable({ reason: state.away }))
      : Effect.succeed(state.client),
  );

/** Why `link` holds no service now, at each change; null while it holds
 *  one. What a window's banner says. */
export const linkOutage = (
  link: ServiceLink<unknown>,
): Stream.Stream<string | null> =>
  link.state.changes.pipe(
    Stream.map((state) => ('away' in state ? state.away : null)),
    Stream.changes,
  );

/** Each reason `link` is away for good ({@link Linked}'s `lasting`): what
 *  ends a wait on the link, and what a window says once as an error. */
export const linkRefusals = (
  link: ServiceLink<unknown>,
): Stream.Stream<string> =>
  link.state.changes.pipe(
    Stream.map((state) =>
      'away' in state && state.lasting ? state.away : null,
    ),
    Stream.changes,
    Stream.filter(Predicate.isNotNull),
  );

/** Between attempts to reach a service that went away: from half a second,
 *  growing, never more than ten seconds apart. */
const RECONNECT = Schedule.min([
  Schedule.exponential('500 millis'),
  Schedule.spaced('10 seconds'),
]);

/** How many starts in a row may fail before the link gives up. */
const FAILED_STARTS = 3;

/** The link's restarts of a service whose start failed: spaced as
 *  {@link RECONNECT}, and over once {@link FAILED_STARTS} failed in a row.
 *  A service that stays up past its start window begins the count again. */
const RESTARTS = RECONNECT.pipe(Schedule.upTo({ times: FAILED_STARTS - 1 }));

/**
 * The one door to this storage root's service, for every host: held for
 * the caller's scope, as {@link ensureService} reaches it, or the
 * {@link ServiceUnavailable} that says why there is none. Where no service
 * is possible (`TEXRA_NO_SERVICE`, Windows), or none runs and the caller
 * starts none, it fails `none`: the caller works in process and has nothing
 * to report. When the service goes away (a newer build retired it, or it
 * died), the link goes null, which a window shows as offline, and reaches
 * the service again the same way until it is back. A service that fails
 * to start {@link FAILED_STARTS} times in a row (it cannot be spawned, it
 * exits or stays silent through its start window, or it answers and is
 * gone again within that window) is not started again: the link stays
 * away for good, saying what failed, where the service's log is and what
 * to do. One that ran longer than its start window and then went away is
 * restarted as ever. A first reach that must
 * wait for an older service to finish its tasks says so through `waiting`,
 * the host's way to tell its user; a later one says it as the link's
 * `away`.
 */
export const linkService = Effect.fn('server.linkService')(function* (
  start: ServiceStart,
  policy: LinkPolicy,
): Effect.fn.Return<
  ServiceLink,
  ServiceUnavailable,
  Scope.Scope | GlobalValues
> {
  if (yield* envFlag(NO_SERVICE))
    return yield* new ServiceUnavailable({
      reason: `${NO_SERVICE} is set`,
      failure: { kind: 'none' },
    });
  if (process.platform === 'win32')
    return yield* new ServiceUnavailable({
      reason: WINDOWS_UNSUPPORTED,
      failure: { kind: 'none' },
    });
  const connect = Effect.fn('connect')(function* (
    begin: ServiceStart,
    beginPolicy: LinkPolicy,
  ) {
    const scope = yield* Scope.make();
    const lost = yield* Deferred.make<void>();
    const connection = yield* ensureService(
      begin,
      beginPolicy,
      Effect.asVoid(Deferred.succeed(lost, undefined)),
    ).pipe(
      Scope.provide(scope),
      Effect.onError(() => Scope.close(scope, Exit.void)),
    );
    return { connection, lost, scope };
  });
  let current = yield* connect(start, policy);
  // The connection the link has reached and not yet held: the first one.
  let reached: typeof current | null = current;
  const state = yield* SubscriptionRef.make<Linked<ServiceClient>>({
    client: current.connection.client,
  });
  const awayFor = (away: string, lasting = false) =>
    SubscriptionRef.set(state, { client: null, away, lasting });
  // While the link is down, a wait on an older service is what the
  // window's banner says.
  const awayWaiting = (message: string) =>
    awayFor(message).pipe(Effect.andThen(Effect.logWarning(message)));
  const refusalTold = yield* Ref.make(false);
  yield* Effect.addFinalizer(() =>
    Effect.suspend(() => Scope.close(current.scope, Exit.void)),
  );
  // Reach the service again. A newer build that retired it is starting its
  // own: the link waits the whole startup window for one to answer, so an
  // older window never races it with one of its build, and starts one
  // itself only when none came, as at startup.
  const reconnect = Effect.suspend(() => {
    let told = '';
    return connect(
      { storageRoot: start.storageRoot, start: Effect.succeed(Effect.never) },
      { startsService: true, waiting: awayWaiting },
    ).pipe(
      Effect.catch(() => connect(start, { ...policy, waiting: awayWaiting })),
      // Said once per reason: a newer protocol's service stays until it
      // exits, and the link keeps trying meanwhile.
      Effect.tapError((error) =>
        Effect.suspend(() => {
          if (error.message === told) return Effect.void;
          told = error.message;
          return (
            error.failure.kind === 'newer'
              ? awayFor(WINDOW_OUTDATED, true)
              : awayFor(SERVICE_OFFLINE)
          ).pipe(
            Effect.andThen(
              Effect.logWarning(
                `The TeXRA service is not back yet: ${error.message}`,
              ),
            ),
          );
        }),
      ),
      // Only a failed start is counted ({@link RESTARTS}): anything else
      // waits on another process (a newer or a wedged service, a caller
      // that starts none), which no restart of this link's can loop on.
      Effect.retry({
        schedule: RECONNECT,
        while: (error) => error.failure.kind !== 'startFailed',
      }),
      Effect.tap((held) =>
        Effect.logInfo(
          `Reconnected to the TeXRA service ${held.connection.info.version} (pid ${held.connection.info.pid}).`,
        ),
      ),
    );
  });
  // One service, from reaching it until it goes away. It fails as a failed
  // start when the service went within its start window (by its own start
  // time, the hello's), and finishes when it had run longer: a service
  // that ran for a while and died is restarted with nothing counted.
  const hold = Effect.gen(function* () {
    const next = reached ?? (yield* reconnect);
    reached = null;
    current = next;
    // Reached: whatever kept it away no longer holds, so a host that
    // attaches later is not told it, and a later refusal is told.
    yield* Ref.set(refusalTold, false);
    yield* SubscriptionRef.set(state, { client: next.connection.client });
    yield* Deferred.await(next.lost);
    yield* awayFor(SERVICE_OFFLINE);
    yield* Scope.close(next.scope, Exit.void);
    const { pid, startedAt } = next.connection.info;
    const upFor = (yield* Clock.currentTimeMillis) - startedAt;
    yield* Effect.logWarning(
      `The TeXRA service (pid ${pid}) went away; reconnecting.`,
    );
    if (upFor < Duration.toMillis(START_TIMEOUT))
      return yield* new ServiceUnavailable({
        reason: `The TeXRA service (pid ${pid}) went away ${Math.max(0, Math.round(upFor / 1000))} seconds after it started.`,
        failure: { kind: 'startFailed' },
      });
  });
  yield* Effect.forkScoped(
    Effect.forever(Effect.retry(hold, RESTARTS)).pipe(
      Effect.catch((last) => {
        const gaveUp = `The TeXRA service failed to start ${FAILED_STARTS} times in a row, so TeXRA stopped restarting it. The last failure: ${last.reason.replace(/\.$/, '')}. Its log is ${servicePaths(start.storageRoot).log}. Fix what the log names, then restart TeXRA (in VS Code, reload the window); with ${NO_SERVICE}=1 set, TeXRA runs tasks without the service.`;
        return awayFor(gaveUp, true).pipe(
          Effect.andThen(Effect.logError(gaveUp)),
        );
      }),
    ),
  );
  return linkOver(state, refusalTold);
});
