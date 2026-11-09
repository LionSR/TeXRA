/**
 * The CLI's side of the TeXRA service: the composition `texra serve` runs
 * (one session per project, opened on demand over that project's own roots,
 * as the desktop opens its folders), the detached start a client asks for
 * when no service answers, and the connection the chat TUI holds.
 */
import * as path from 'node:path';

import {
  Context,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Path,
  RcMap,
  Result,
  Scope,
  Stream,
  SubscriptionRef,
} from 'effect';

import { type LocalSession, type Sessions } from '@texra-ai/harness';
import {
  AppState,
  type GlobalValues,
  StateStores,
} from '@texra-ai/harness/host';
import { withLogChannel } from '@texra-ai/harness/plugins';
import {
  openNodeWorkspaceRoots,
  canonicalizeWorkspaceRoot,
  resolveGlobalStoragePath,
  envFlag,
  JsonStore,
  setLogSink,
} from '@texra-ai/harness/node';
import { ensureError } from '@texra-ai/harness/schemas';
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';
import { openLocalSession } from '@texra/controllers/session/openProjectSession';
import { TEXRA_CONFIG_FILE_NAME } from '@texra/platform/defaults/nodeStorage';
import { openTexraWorkspaceConfigStores } from '@texra/platform/defaults/nodeStores';
import { type ServiceInfo } from '@texra/controllers/server/protocol';
import type {
  ServiceLoad,
  ServiceProject,
  ServiceProjects,
} from '@texra/controllers/server/service';
import {
  isOlder,
  linkService,
  probeRecordedService,
  spawnService,
  type ServiceConnection,
  type ServiceLink,
  type ServiceUnavailable,
  WINDOWS_UNSUPPORTED,
} from '@texra/controllers/server/client';
import { TEXRA_SETTINGS } from '@texra/shared/settingsView/texraSettings';
import { sessionStoreMovedAsideMessage } from '@ui/copy/sessionStore';

import { readCliEntrypointPath } from './cliContext';
import { silentLogSink, writeTextStderr } from './logSinks';
import type { CliContext } from './cliContext';

/** The service's own log channel. */
const CHANNEL = 'cliService';

/**
 * The service's projects over the CLI's node roots, opened in `scope` and
 * closed with it. A project is its session, opened on first use and
 * released once nothing has held it for `idleAfter` (`RcMap`): a client's
 * lease is its scope on `open`, and a run at work holds a lease of the
 * project's own, taken as the view shows one and let go as none is left,
 * so a project with a task running never idles out.
 */
export const cliServiceProjects = Effect.fn('cliServiceProjects')(function* (
  context: Pick<CliContext, 'storageRoot'>,
  scope: Scope.Scope,
  /** The process's sessions, which each project's session is also opened
   *  through. */
  sessions: Context.Service.Shape<typeof Sessions>,
  idleAfter: Duration.Input,
) {
  const { storageRoot } = context;
  const globalState = yield* AppState;
  // The windows and the CLI write these files while the service runs: a
  // store's read serves what they hold now, so a setting changed in any
  // client reaches the next task and the next turn.
  const globalConfig = yield* JsonStore.open(
    path.join(resolveGlobalStoragePath(storageRoot), TEXRA_CONFIG_FILE_NAME),
  );
  const openRoots = Effect.fn('cliServiceProjects.openRoots')(function* (
    workspace: string | undefined,
    within: Scope.Scope,
  ) {
    // The config open reports through a plain callback while it runs; its
    // warnings are logged once it has.
    const warnings: string[] = [];
    const configs = yield* openTexraWorkspaceConfigStores(
      TEXRA_SETTINGS.catalog,
      storageRoot,
      workspace,
      (message) => warnings.push(message),
    );
    yield* Effect.forEach(
      warnings,
      (message) => Effect.logWarning(message).pipe(withLogChannel(CHANNEL)),
      { discard: true },
    );
    return yield* openNodeWorkspaceRoots({
      workspaceRoot: workspace,
      storageRoot,
      config: {
        ...configs,
        global: globalConfig,
        catalog: TEXRA_SETTINGS.catalog,
      },
      stateStores: yield* StateStores,
      globalState,
    }).pipe(Scope.provide(within));
  });
  // What opening a project reads, captured once: `open` is the port's,
  // called from handlers that hold no process context of their own. Exactly
  // these services, never the build's scope with them: provided over a
  // handler's lease, that scope would hold the lease's release until the
  // service exits, so no project would ever go idle.
  const services = Context.pick(
    ChildProcessSpawner,
    FileSystem.FileSystem,
    Path.Path,
    StateStores,
  )(
    yield* Effect.context<
      ChildProcessSpawner | FileSystem.FileSystem | Path.Path | StateStores
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
  const lookup = Effect.fn('cliServiceProjects.lookup')(function* (
    root: string,
  ): Effect.fn.Return<
    ServiceProject,
    Error,
    | Scope.Scope
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
    const roots = yield* openRoots(root, projectScope);
    // A project store is held by one process, and one service serves a
    // storage root at a time (the client that replaces a service waits for
    // its exit), so a held store is another process's to answer for. The
    // session closes as the project is released, before its roots
    // (registered after them, so released first); the service's exit
    // closes every session ahead of that (`serve`'s settle).
    const session = yield* openLocalSession(sessions, roots);
    // A store moved aside at open (pre-1.0 or corrupt) is said once, in
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
    // stops, resumable).
    let hold: Scope.Closeable | null = null;
    const follow = (busy: boolean) =>
      Effect.gen(function* () {
        if (busy === (hold !== null)) return;
        if (busy) {
          hold = yield* Scope.make();
          // The entry exists: this runs inside its own lookup's scope.
          yield* RcMap.get(projects, root).pipe(
            Scope.provide(hold),
            Effect.orDie,
          );
          yield* count(0, 1);
          return;
        }
        const held = hold;
        hold = null;
        if (held !== null) yield* Scope.close(held, Exit.void);
        yield* count(0, -1);
      });
    yield* Effect.forkScoped(
      Stream.runForEach(
        session.view.changes.pipe(
          Stream.map((view) =>
            [...view.runs.values()].some(
              (run) => run.holder === 'here' && run.position !== 'waiting',
            ),
          ),
          Stream.changes,
        ),
        follow,
      ).pipe(Effect.ensuring(follow(false))),
    );
    return { session };
  });
  const projects: RcMap.RcMap<string, ServiceProject, Error> =
    yield* RcMap.make({
      lookup: (root: string) => lookup(root).pipe(Effect.mapError(ensureError)),
      idleTimeToLive: idleAfter,
    }).pipe(Scope.provide(scope));
  return {
    storageRoot,
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
  } satisfies Context.Service.Shape<typeof ServiceProjects>;
});

/** A client prints its own result; its process's log lines go nowhere, as
 *  a platform command's do (`CliPlatform`). The service keeps its own
 *  log. */
const quietClient = Effect.sync(() =>
  setLogSink(silentLogSink, { trusted: true }),
);

/** The hello of the storage root's service, or null when none answers. */
export const probeCliService: Effect.Effect<
  ServiceInfo | null,
  ServiceUnavailable,
  GlobalValues
> = quietClient.pipe(Effect.andThen(probeRecordedService));

/** `TEXRA_NO_SERVICE=1`: this process uses no background service, so a
 *  chat runs here, as where the service cannot run. */
const NO_SERVICE = 'TEXRA_NO_SERVICE';

/** Start this build's service on `storageRoot`, detached. */
const spawnOwnService = (storageRoot: string) =>
  spawnService(storageRoot, process.execPath, [
    ...process.execArgv,
    readCliEntrypointPath(),
    'serve',
  ]);

/** What the link's starter says instead of starting a service. */
const NONE_RUNNING = 'no TeXRA service is running';

/** The storage root's service as a CLI process holds it: linked for the
 *  process's life, or why it holds none. */
export type CliServiceLink = ServiceLink | { readonly none: string };

/** Whether `link` holds a service. */
export const isLinked = (link: CliServiceLink): link is ServiceLink =>
  'client' in link;

/**
 * The one door to the storage root's service: linked for the caller's
 * scope, started when none answers if `start` (a command that runs or
 * lists tasks), else linked only when one runs. An older build's service
 * holds the projects it serves, and a project store is held by one
 * process, so this build cannot open one beside it: the command retires
 * that service and links to the one it starts in its place, whatever
 * `start` says. Answers why it holds none where none is possible
 * (`TEXRA_NO_SERVICE`, Windows), none runs and `start` is off, or the
 * service could not be reached or started (a newer build's refuses this
 * one): the caller says it, and works in process.
 */
export const linkCliService = Effect.fn('linkCliService')(function* (
  storageRoot: string,
  start: boolean,
): Effect.fn.Return<CliServiceLink, never, Scope.Scope | GlobalValues> {
  if (yield* envFlag(NO_SERVICE)) return { none: `${NO_SERVICE} is set` };
  if (process.platform === 'win32') return { none: WINDOWS_UNSUPPORTED };
  // A service that should answer and does not is said here, once, on
  // stderr: every command then works in process, and the ones that fall
  // back without a word of their own (history, a headless run) would
  // otherwise hide the cause behind a store another process holds.
  const reach = (reason: string) => {
    const none = `The TeXRA service could not be reached: ${reason}`;
    writeTextStderr(none);
    return { none };
  };
  const probed = yield* Effect.result(probeRecordedService);
  if (Result.isFailure(probed)) return reach(probed.failure.reason);
  const info = probed.success;
  if (info === null && !start) return { none: NONE_RUNNING };
  const linked = yield* Effect.result(
    linkService(
      storageRoot,
      start || (info !== null && isOlder(info))
        ? spawnOwnService(storageRoot)
        : Effect.fail(new Error(NONE_RUNNING)),
      // The wait lasts as long as the older build's tasks, so the command
      // says what it waits for and how to stop waiting.
      (waitingFor) =>
        Effect.sync(() =>
          writeTextStderr(
            `${waitingFor} To stop waiting, run \`texra service stop\`: its running tasks stop and can be resumed.`,
          ),
        ),
    ),
  );
  return Result.isFailure(linked)
    ? reach(linked.failure.reason)
    : linked.success;
});

/** The service's client through `link`, for one connection's use; a link
 *  that holds none now fails with why. */
export const linkClient = (
  link: ServiceLink,
): Effect.Effect<Pick<ServiceConnection, 'client'>, Error> =>
  Effect.flatMap(link.client.get, (client) =>
    client === null
      ? Effect.flatMap(SubscriptionRef.get(link.away), (away) =>
          Effect.fail(new Error(away)),
        )
      : Effect.succeed({ client }),
  );
