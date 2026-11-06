/**
 * The CLI's side of the TeXRA service: the composition `texra serve` runs
 * (one session per project, opened on demand over that project's own roots,
 * as the desktop opens its folders), the detached start a client asks for
 * when no service answers, and the connection the chat TUI holds.
 */
import * as path from 'node:path';

import {
  Clock,
  Context,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Path,
  Predicate,
  Schedule,
  Scope,
} from 'effect';

import { API_KEY_ENV_NAMES } from '@texra-ai/llm';
import { type Sessions } from '@texra-ai/harness';
import {
  AppState,
  type GlobalValues,
  storeHeld,
  withLogChannel,
  withPerKeyLane,
  type PerKeyLane,
  StateStores,
} from '@texra-ai/harness/host';
import {
  openNodeWorkspaceRoots,
  canonicalizeWorkspacePath,
  resolveGlobalStoragePath,
  envFlag,
  JsonStore,
  setLogSink,
} from '@texra-ai/harness/node';
import { ensureError } from '@texra-ai/harness/schemas';
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';
import { recordFirstCompletedRun } from '@texra/controllers/onboarding/onboardingFunnel';
import { TEXRA_CONFIG_FILE_NAME } from '@texra/platform/defaults/nodeStorage';
import { openTexraWorkspaceConfigStores } from '@texra/platform/defaults/nodeStores';
import {
  BUILD_VERSION,
  PROTOCOL,
  type ServiceInfo,
} from '@texra/controllers/server/protocol';
import type {
  ServiceProject,
  ServiceProjects,
} from '@texra/controllers/server/handlers';
import {
  ensureService,
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
import { loginShellEnvironment } from './loginShellEnv';

import { cliEnvValue, readCliEntrypointPath } from './cliContext';
import { silentLogSink } from './logSinks';
import type { CliContext } from './cliContext';

/** The service's own log channel. */
const CHANNEL = 'cliService';

/** How long a project store held by another process is tried again for:
 *  a retiring service exits within a second of its last task, and its
 *  stores close with it. */
const STORE_RELEASE_WAIT = '15 seconds';

/**
 * The service's projects over the CLI's node roots, opened in `scope` and
 * closed with it.
 */
export const cliServiceProjects = Effect.fn('cliServiceProjects')(function* (
  context: Pick<CliContext, 'storageRoot'>,
  scope: Scope.Scope,
  /** The process's sessions, which each project's session is also opened
   *  through. */
  sessions: Context.Service.Shape<typeof Sessions>,
) {
  const { storageRoot } = context;
  const globalState = yield* AppState;
  // The windows and the CLI write these files while the service runs: each
  // read serves what they hold now, so a setting changed in any client
  // reaches the next task and the next turn.
  const globalConfig = yield* JsonStore.open(
    path.join(resolveGlobalStoragePath(storageRoot), TEXRA_CONFIG_FILE_NAME),
    { follow: true },
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
      true,
    );
    yield* Effect.forEach(
      warnings,
      (message) => Effect.logWarning(message).pipe(withLogChannel(CHANNEL)),
      { discard: true },
    );
    return yield* openNodeWorkspaceRoots({
      workspacePath: workspace,
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
  // Each project's approval policy is its persisted setting, which the
  // session reads at every decision through these following config stores:
  // a change any client writes applies to the next request, and nothing a
  // window holds can replace it.
  //
  // A project is its session and the scope its stores live in, leased by
  // the callers that use it. Opening, leasing and closing one run on the
  // project's lane, so a close sees every lease taken before it and an open
  // after it opens the project anew.
  interface Project extends ServiceProject {
    readonly scope: Scope.Closeable;
    leases: number;
    idleSince: number;
  }
  const projects = new Map<string, Project>();
  const lanes = new Map<string, PerKeyLane>();
  const lease = (root: string) =>
    Effect.gen(function* () {
      let project = projects.get(root);
      if (project === undefined) {
        const projectScope = yield* Scope.fork(scope);
        const opened = yield* Effect.gen(function* () {
          const roots = yield* openRoots(root, projectScope);
          // A project store is held by one process. The service this one
          // replaced releases the project as it exits, a moment after it
          // stopped taking work (`serve.ts`): a held store is tried again
          // for a while before the open is refused.
          const session = yield* sessions
            .open(roots, { persistent: true, host: {} })
            .pipe(
              Effect.retry({
                while: storeHeld,
                schedule: Schedule.spaced('250 millis').pipe(
                  Schedule.upTo({ duration: STORE_RELEASE_WAIT }),
                ),
              }),
            );
          yield* recordFirstCompletedRun(session).pipe(
            Scope.provide(projectScope),
          );
          // A store moved aside at open (pre-1.0 or corrupt) is said once,
          // in the service's log and to the project's first window: the
          // windows open no store of their own to notice it.
          const moved = session.storeMovedAside;
          if (moved) {
            const message = sessionStoreMovedAsideMessage(moved);
            yield* Effect.logWarning(message).pipe(withLogChannel(CHANNEL));
            yield* session.emit('requestShowInstruction', {
              key: `store-moved-aside-${moved.aside}`,
              message,
            });
          }
          return { session };
        }).pipe(Effect.onError(() => Scope.close(projectScope, Exit.void)));
        project = { ...opened, scope: projectScope, leases: 0, idleSince: 0 };
        projects.set(root, project);
      }
      project.leases += 1;
      return project;
    }).pipe(withPerKeyLane(lanes, root));
  const open = (workspace: string) => {
    const root = canonicalizeWorkspacePath(workspace);
    return Effect.acquireRelease(lease(root), (project) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        project.leases -= 1;
        if (project.leases === 0) project.idleSince = now;
      }),
    ).pipe(
      Effect.map(({ session }): ServiceProject => ({ session })),
      Effect.mapError(ensureError),
      Effect.provideContext(services),
    );
  };
  /** Close `root` if it is still unleased, holds no run and has been idle
   *  for `idleMs`; a run held restarts its idle time. */
  const closeIfIdle = (root: string, idleMs: number) =>
    Effect.gen(function* () {
      const project = projects.get(root);
      if (project === undefined || project.leases > 0) return undefined;
      const now = yield* Clock.currentTimeMillis;
      const { session } = project;
      // What this process runs now (its registry), not the claims the view
      // shows: a run held here keeps the project open.
      if (session.held().length > 0) {
        project.idleSince = now;
        return undefined;
      }
      if (now - project.idleSince < idleMs) return undefined;
      projects.delete(root);
      // The stores close even if the session's close fails.
      yield* sessions
        .close(session.roots)
        .pipe(Effect.ensuring(Scope.close(project.scope, Exit.void)));
      return session;
    }).pipe(withPerKeyLane(lanes, root), Effect.provideContext(services));
  return {
    storageRoot,
    open,
    opened: Effect.sync(
      () =>
        new Map(
          [...projects.values()].map(({ session }) => [
            session.roots.storage,
            session,
          ]),
        ),
    ),
    closeIdle: (idleFor) =>
      Effect.map(
        // Each project closes in its own lane, so they close at once.
        Effect.forEach(
          [...projects.keys()],
          (root) => closeIfIdle(root, Duration.toMillis(idleFor)),
          { concurrency: 'unbounded' },
        ),
        (closed) => closed.filter(Predicate.isNotUndefined),
      ),
  } satisfies Context.Service.Shape<typeof ServiceProjects>;
});

/** A client prints its own result; its process's log lines go nowhere, as
 *  a platform command's do (`initCliPlatform`). The service keeps its own
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

/** Connect to the storage root's service, starting it when none answers
 *  and retiring one older than this build. Leaves the process's log sink as
 *  it is: what the chat uses. */
export function reachCliService(
  storageRoot: string,
): Effect.Effect<ServiceConnection, Error, Scope.Scope | GlobalValues> {
  return Effect.flatMap(envFlag(NO_SERVICE), (off) =>
    off
      ? Effect.fail(new Error(`${NO_SERVICE} is set`))
      : ensureService(storageRoot, spawnOwnService(storageRoot)),
  );
}

/** Start this build's service on `storageRoot`, detached. */
const spawnOwnService = (storageRoot: string) =>
  spawnService(storageRoot, process.execPath, [
    ...process.execArgv,
    readCliEntrypointPath(),
    'serve',
  ]);

/** What the link's starter says instead of starting a service. */
const NONE_RUNNING = 'no TeXRA service is running';

/**
 * The storage root's running service of this build's protocol, linked for
 * the caller's scope, or undefined when there is none to link:
 * `TEXRA_NO_SERVICE`, Windows, or no service running (a command never
 * starts one for itself). An older build's service holds the projects it
 * serves, and a project store is held by one process, so this build cannot
 * open one beside it: the command retires that service and links to the
 * one it starts in its place, as the chat does. A service that is there
 * but cannot be linked (a newer build's, an unreadable record, one that
 * does not answer) fails, so no command works beside it on the project's
 * store.
 */
export const linkRunningCliService = Effect.fn('linkRunningCliService')(
  function* (
    storageRoot: string,
  ): Effect.fn.Return<
    ServiceLink | undefined,
    Error,
    Scope.Scope | GlobalValues
  > {
    if (yield* envFlag(NO_SERVICE)) return undefined;
    if (process.platform === 'win32') return undefined;
    const info = yield* probeRecordedService.pipe(
      Effect.mapError(
        (error) =>
          new Error(`The TeXRA service could not be reached: ${error.reason}`),
      ),
    );
    if (info === null) return undefined;
    if (info.protocol > PROTOCOL.version)
      return yield* Effect.fail(
        new Error(
          `A newer TeXRA (${info.version}, pid ${info.pid}) serves this storage root; this build (${BUILD_VERSION}) cannot work beside it.`,
        ),
      );
    return yield* linkService(
      storageRoot,
      isOlder(info)
        ? spawnOwnService(storageRoot)
        : Effect.fail(new Error(NONE_RUNNING)),
    ).pipe(
      Effect.mapError(
        (error) =>
          new Error(`The TeXRA service could not be reached: ${error.reason}`),
      ),
    );
  },
);

/**
 * Start the storage root's service when none answers, and leave it
 * running: what the chat and `texra resume` do before the platform comes
 * up, so the platform links to it ({@link linkRunningCliService}). Answers
 * null, or why this process uses none (`TEXRA_NO_SERVICE`, Windows), which
 * the caller says once; a service that cannot start fails with its reason.
 */
export const startCliService = Effect.fn('startCliService')(function* (
  storageRoot: string,
): Effect.fn.Return<string | null, Error, GlobalValues> {
  if (yield* envFlag(NO_SERVICE)) return `${NO_SERVICE} is set`;
  if (process.platform === 'win32') return WINDOWS_UNSUPPORTED;
  yield* Effect.scoped(reachCliService(storageRoot));
  return null;
});

/** {@link reachCliService} for a client command, whose process prints only
 *  its own result. */
export function connectCliService(
  storageRoot: string,
): Effect.Effect<ServiceConnection, Error, Scope.Scope | GlobalValues> {
  return quietClient.pipe(Effect.andThen(reachCliService(storageRoot)));
}

/**
 * What a client says when this terminal sets a provider key the service
 * will not take from it. The service reads keys from the shared key store,
 * the project's `.env` and its own login shell, never from a client, so a
 * key this terminal set itself (`OPENAI_API_KEY=… texra chat`) does not
 * reach the task. Null when every such key is the login shell's own.
 */
export const serviceKeysNotice = Effect.fn('serviceKeysNotice')(
  function* (): Effect.fn.Return<string | null, never, ChildProcessSpawner> {
    const own = (name: string) => cliEnvValue(name)?.trim() || undefined;
    const set = API_KEY_ENV_NAMES.filter((name) => own(name) !== undefined);
    if (set.length === 0) return null;
    // Best effort, for a notice only: a login shell that does not answer
    // leaves the service without those keys too.
    const login = yield* loginShellEnvironment().pipe(
      Effect.orElseSucceed((): Readonly<Record<string, string>> => ({})),
    );
    const unseen = set.filter((name) => login[name]?.trim() !== own(name));
    if (unseen.length === 0) return null;
    const one = unseen.length === 1;
    return `${unseen.join(', ')} from this terminal ${one ? 'does' : 'do'} not reach tasks in the TeXRA service, which reads keys from \`texra setup\`, the project's .env and your login shell. Run with TEXRA_NO_SERVICE=1 to use this terminal's ${one ? 'key' : 'keys'}.`;
  },
);
