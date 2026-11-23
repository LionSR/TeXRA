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
 *   for `idleAfter`, a run at work included) and no task starting, for
 *   `idleAfter` more (a conversation waiting for its next message stops
 *   with it, resumable, as in a drain).
 *
 * Whichever ends it, it leaves as a drain does first: no task starts; the
 * record is released as it exits. It never starts at login: a client starts it detached when none answers.
 * Its projects are its own (one session per project, opened on demand over
 * that project's own roots, as the desktop opens its folders), and it
 * closes every session the process opened, and then every project's roots
 * (its hold on the project's store), before its socket closes: the socket
 * closing is what tells a client the stores are free. Every
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
  Exit,
  FileSystem,
  Layer,
  Path,
  RcMap,
  Schema,
  Scope,
  Stream,
  SubscriptionRef,
} from 'effect';
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';
import { RpcSerialization, RpcServer } from 'effect/rpc';

import { type LocalSession, Sessions } from '@texra-ai/worldline';
import type { ProcessServices } from '@texra-ai/worldline/host';
import {
  canonicalizeWorkspaceRoot,
  IS_WINDOWS,
} from '@texra-ai/worldline/node';
import {
  withLogChannel,
  AppState,
  GlobalValues,
  StateStores,
} from '@texra-ai/worldline/plugins';
import { ensureError } from '@texra-ai/worldline/schemas';
import {
  openGlobalConfig,
  openLocalSession,
  openProjectRoots,
} from '@texra/controllers/session/openProjectSession';
import { sessionStoreMovedAsideMessage } from '@ui/copy/sessionStore';
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
  type ServiceControl,
  type ServiceLoad,
  type ServiceProjects,
  serviceHandlers,
  runningTasks,
  runsAtWork,
} from './service';
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
  /** The storage root every project's store sits under. */
  readonly storageRoot: string;
  /** Exit after this long with no client and no task at work. */
  readonly idleAfter: Duration.Input;
  /** The host's own stop (a signal): ends the run as a `stop` would. */
  readonly shutdown: Deferred.Deferred<void>;
}

/** The service's own log channel. */
const CHANNEL = 'service';

/**
 * The service's projects over `storageRoot`, opened in the caller's scope
 * and closed with it. A project is its session, opened on first use and
 * released once nothing has held it for `idleAfter` (`RcMap`): a client's
 * lease is its scope on `open`, and a run at work holds a lease of the
 * project's own, taken as the view shows one and let go as none is left,
 * so a project with a task running never idles out.
 */
const openProjects = Effect.fn('server.openProjects')(function* (
  storageRoot: string,
  idleAfter: Duration.Input,
) {
  // The process's sessions, which each project's session is opened through.
  const sessions = yield* Sessions;
  // The windows and the CLI write these files while the service runs: a
  // store's read serves what they hold now, so a setting changed in any
  // client reaches the next task and the next turn.
  // The service has no window: what a config open finds is in its log.
  const logged = () => Effect.void;
  const globalConfig = yield* openGlobalConfig(storageRoot, logged);
  // What opening a project reads, captured once: `open` is called from
  // handlers that hold no process context of their own. Exactly these
  // services, never the service's scope with them: provided over a
  // handler's lease, that scope would hold the lease's release until the
  // service exits, so no project would ever go idle.
  const services = Context.pick(
    AppState,
    ChildProcessSpawner,
    FileSystem.FileSystem,
    Path.Path,
    StateStores,
  )(
    yield* Effect.context<
      | AppState
      | ChildProcessSpawner
      | FileSystem.FileSystem
      | Path.Path
      | StateStores
    >(),
  );
  // The sessions open now, by storage root, and the load they carry (a
  // project counts as open from its lookup's first read): what the task
  // list reads and the service's lifetime follows.
  const open = new Map<string, LocalSession>();
  const load = yield* SubscriptionRef.make<ServiceLoad>({
    open: 0,
    working: 0,
  });
  const count = (opened: number, working: number) =>
    SubscriptionRef.update(load, (now) => ({
      open: now.open + opened,
      working: now.working + working,
    }));
  // Each project's approval policy is its persisted setting, which the
  // session reads at every decision through these following config stores:
  // a change any client writes applies to the next request, and nothing a
  // window holds can replace it.
  const lookup = Effect.fn('server.openProjects.lookup')(function* (
    root: string,
  ): Effect.fn.Return<
    LocalSession,
    Error,
    | Scope.Scope
    | AppState
    | ChildProcessSpawner
    | FileSystem.FileSystem
    | Path.Path
    | StateStores
  > {
    const projectScope = yield* Effect.scope;
    // Counted as open from the first read of the lookup, not from the
    // session's open: the idle decision reads this count, and a project
    // still opening when the idle deadline passes is one the service
    // serves, not one it may leave. A failed lookup gives the count back
    // with its scope.
    yield* Effect.acquireRelease(count(1, 0), () => count(-1, 0));
    // The service is the process that holds each project's state.
    const roots = yield* openProjectRoots(
      storageRoot,
      root,
      globalConfig,
      undefined,
      logged,
    ).pipe(Scope.provide(projectScope));
    // A project store is held by one process, and one service serves a
    // storage root at a time (the client that replaces a service waits for
    // its exit), so a held store is another process's to answer for. The
    // session closes as the project is released, before its roots
    // (registered after them, so released first); the service's exit
    // closes every session ahead of that (`serve`'s close of the sessions).
    const session = yield* openLocalSession(sessions, roots);
    // A damaged store moved aside at open is said once, in
    // the service's log and to the project's first window: the windows
    // open no store of their own to notice it.
    const moved = session.storeMovedAside;
    if (moved) {
      const message = sessionStoreMovedAsideMessage(moved);
      yield* Effect.logWarning(message).pipe(withLogChannel(CHANNEL));
      yield* session.emit('requestShowInstruction', {
        key: `store-moved-aside-${moved.aside}`,
        message,
      });
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => open.set(session.roots.storage, session)),
      () => Effect.sync(() => open.delete(session.roots.storage)),
    );
    // A run at work holds the project through a lease of the project's
    // own (not one waiting for its next message, which the service's close
    // stops, resumable). The lease closes before the count drops, and the
    // view ending counts as idle.
    const held = Effect.acquireRelease(count(0, 1), () => count(0, -1)).pipe(
      // The entry exists: this runs inside its own lookup's scope.
      Effect.andThen(RcMap.get(projects, root)),
      Effect.orDie,
      Effect.andThen(Effect.never),
      Stream.fromEffect,
      Stream.scoped,
    );
    yield* Effect.forkScoped(
      session.view.changes.pipe(
        Stream.map(() => runsAtWork(session) > 0),
        Stream.concat(Stream.succeed(false)),
        Stream.changes,
        Stream.switchMap((busy) => (busy ? held : Stream.empty)),
        Stream.runDrain,
      ),
    );
    return session;
  });
  const projects: RcMap.RcMap<string, LocalSession, Error> = yield* RcMap.make({
    lookup: (root: string) => lookup(root).pipe(Effect.mapError(ensureError)),
    idleTimeToLive: idleAfter,
  });
  return {
    // A lookup that failed (a store another process still holds) is not
    // kept for the idle time: the next open tries again.
    open: (workspace) => {
      const key = canonicalizeWorkspaceRoot(workspace);
      return RcMap.get(projects, key).pipe(
        Effect.tapError(() => RcMap.invalidate(projects, key)),
        Effect.provideContext(services),
      );
    },
    opened: Effect.sync(() => new Map(open)),
    load,
  } satisfies ServiceProjects;
});

/** How long the watch streams get, after the tasks are stopped, to end
 *  with their sessions and carry the last rows before the socket closes: a
 *  deadline for a client that is not reading, not a wait. */
const WATCH_END_DEADLINE = '5 seconds';

/**
 * Serve {@link TexraRpcs} on the storage root's socket until the service
 * stops, drains or idles out. A plain `Error` is the global config file
 * that could not be read.
 */
export const serve = Effect.fn('server.serve')(function* (
  options: ServeOptions,
): Effect.fn.Return<
  ServeExit,
  ServiceAlreadyRunning | ServiceListenFailed | ServiceUnavailable | Error,
  ProcessServices | Sessions | HostWindows | Scope.Scope
> {
  if (IS_WINDOWS)
    return yield* new ServiceListenFailed({
      socket: '',
      cause: new Error(WINDOWS_UNSUPPORTED),
    });
  const fs = yield* FileSystem.FileSystem;
  // In a scope of their own, which the exit below closes before the socket:
  // a client takes the socket's close to mean the service holds no project
  // store any more (`stopService`), and a store is held exclusively. A run
  // that fails instead closes them with its scope, after the socket.
  const projectsScope = yield* Scope.fork(yield* Effect.scope);
  const projects = yield* openProjects(
    options.storageRoot,
    options.idleAfter,
  ).pipe(Scope.provide(projectsScope));
  const paths = servicePaths(options.storageRoot);
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
  // starts under way; one value, so a start is claimed in the
  // same step that checks for a leave.
  const state = yield* SubscriptionRef.make<{
    readonly leaving: 'drain' | 'end' | null;
    readonly starting: number;
  }>({ leaving: null, starting: 0 });
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
  // Every end leaves first, so no task starts once the run has ended.
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
  const control: ServiceControl = {
    socket,
    startedAt,
    clients: Effect.map(protocol.clientIds, (ids) => ids.size),
    draining: Effect.map(
      SubscriptionRef.get(state),
      (now) => now.leaving !== null,
    ),
    holdStart: Effect.acquireRelease(
      SubscriptionRef.modify(state, (now) =>
        now.leaving !== null
          ? [false, now]
          : [true, { ...now, starting: now.starting + 1 }],
      ),
      (held) =>
        held
          ? SubscriptionRef.update(state, (now) => ({
              ...now,
              starting: now.starting - 1,
            }))
          : Effect.void,
    ),
    watching: yield* SubscriptionRef.make(0),
    stop: (drain) => (drain ? leave('drain') : end('stopped')),
  };
  yield* Effect.forkScoped(
    RpcServer.make(TexraRpcs).pipe(
      Effect.provide(serviceHandlers(projects, control)),
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
  // A drain ends once no task is at work and none is starting. The
  // projects' load is the trigger; the decision reads the registries, which
  // hold a run as its start ends, where the view shows it only once its
  // rows fold.
  yield* Effect.forkScoped(
    facts.pipe(
      Stream.filterEffect(([now]) =>
        now.leaving === 'drain' && now.starting === 0
          ? Effect.map(runningTasks(projects, true), (atWork) => atWork === 0)
          : Effect.succeed(false),
      ),
      Stream.runHead,
      Effect.andThen(Deferred.succeed(ended, 'drained')),
    ),
  );
  // Idle: no project open and nothing starting, for `idleAfter`. The leave
  // is decided in the same step that checks the starts again, so a
  // start that landed meanwhile keeps its run.
  yield* Effect.forkScoped(
    facts.pipe(
      Stream.map(
        ([now, load]) =>
          now.leaving === null && now.starting === 0 && load.open === 0,
      ),
      Stream.changes,
      Stream.debounce(options.idleAfter),
      Stream.filter((idle) => idle),
      Stream.mapEffect(() =>
        SubscriptionRef.modify(state, (now) =>
          now.leaving === null && now.starting === 0
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
  // Every task stopped and finished while the clients are still connected,
  // so they see each task's last rows.
  yield* (yield* Sessions).closeAll;
  // The watch streams end with the sessions just closed, each having
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
  // Each project's roots, and with them the last hold on its store.
  yield* Scope.close(projectsScope, Exit.void);
  return exit;
}, Effect.scoped);
