/**
 * The CLI's side of the TeXRA service: the composition `texra serve` runs
 * (one session per project, opened on demand over that project's own roots,
 * as the desktop opens its folders), the detached start a client asks for
 * when no service answers, and the connection the chat TUI holds.
 */
import { homedir, hostname } from 'node:os';
import * as path from 'node:path';

import {
  Duration,
  Effect,
  Exit,
  Scope,
  type Context,
  type FileSystem,
  type Path,
} from 'effect';

import { API_KEY_ENV_NAMES } from '@texra-ai/llm';
import { AppState, SessionOwner } from '@texra-ai/harness';
import {
  createNodeWorkspaceRoots,
  canonicalizeWorkspacePath,
  resolveGlobalStoragePath,
  resolveWorkspaceStoragePath,
} from '@texra-ai/harness/node';
import type { SessionHandle } from '@agent/runtime';
import {
  openProjectStateStore,
  openRepoStateStore,
} from '@controllers/session/appStateStore';
import { setLogSink, silentLogSink, writeLogLine } from '@logger/logSink';
import { JsonStore } from '@platform/defaults/jsonStore';
import { loginShellEnvironment } from '@platform/defaults/loginShellEnv';
import { TEXRA_CONFIG_FILE_NAME } from '@platform/defaults/nodeStorage';
import { openTexraWorkspaceConfigStores } from '@platform/defaults/nodeStores';
import type {
  GlobalDatabase,
  ProjectDatabases,
} from '@shared/session/database';
import { ownerIdentity, type OwnerId } from '@shared/schemas';
import type { ServiceInfo } from '@texra/controllers/server/protocol';
import type { ServiceProjects } from '@texra/controllers/server/handlers';
import {
  ensureService,
  linkService,
  probeRecordedService,
  spawnService,
  type ServiceConnection,
  type ServiceLink,
  type ServiceUnavailable,
} from '@texra/controllers/server/client';
import { bootstrapHost } from '@texra/controllers/hostBootstrap';
import { envFlag } from '@utils/system/envFlags';
import { withPerKeyLane, type PerKeyLane } from '@utils/core/perKeyQueue';
import { ensureError } from '@utils/errors/errorMessage';

import { cliEnvValue, readCliEntrypointPath } from './cliContext';
import type { CliContext } from './cliContext';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

/**
 * The service's projects over the CLI's node roots, opened in `scope` and
 * closed with it. The process bootstrap (skills, the tool seed) runs once
 * here over the no-workspace roots, as the desktop's does, so serving never
 * records a folder of its own as a project.
 */
export const cliServiceProjects = Effect.fn('cliServiceProjects')(function* (
  context: Pick<
    CliContext,
    'storageRoot' | 'resourcesPath' | 'skillSourceOptions'
  >,
  scope: Scope.Scope,
) {
  const { storageRoot } = context;
  const globalStorage = resolveGlobalStoragePath(storageRoot);
  const globalState = yield* AppState;
  const warn = (message: string) => writeLogLine('WARN', 'cliService', message);
  // The windows and the CLI write these files while the service runs: each
  // read serves what they hold now, so a setting changed in any client
  // reaches the next task and the next turn.
  const follow = (error: Error) =>
    warn(
      `A TeXRA config file changed but could not be read; the service keeps its previous settings until it is fixed: ${error.message}`,
    );
  const globalConfig = yield* JsonStore.open(
    path.join(globalStorage, TEXRA_CONFIG_FILE_NAME),
    { follow },
  );
  const openRoots = Effect.fn('cliServiceProjects.openRoots')(function* (
    workspace: string | undefined,
    within: Scope.Scope,
  ) {
    const storage = resolveWorkspaceStoragePath(storageRoot, workspace);
    const [workspaceState, repoState, configs] = yield* Effect.all(
      [
        openProjectStateStore(storage, workspace),
        openRepoStateStore(workspace, storage),
        openTexraWorkspaceConfigStores(storage, workspace, warn, follow),
      ],
      { concurrency: 'unbounded' },
    ).pipe(Scope.provide(within));
    return createNodeWorkspaceRoots({
      host: 'cli',
      workspacePath: workspace,
      storage,
      globalStorage,
      config: { ...configs, global: globalConfig },
      workspaceState,
      repoState,
      globalState,
    });
  });
  yield* bootstrapHost({
    roots: yield* openRoots(undefined, scope),
    skills: {
      resourcesPath: context.resourcesPath,
      skillSourceOptions: context.skillSourceOptions,
    },
  });

  // What opening a project reads, captured once: `open` is the port's,
  // called from handlers that hold no process context of their own.
  const services = yield* Effect.context<
    | ChildProcessSpawner
    | FileSystem.FileSystem
    | GlobalDatabase
    | Path.Path
    | ProjectDatabases
    | SessionOwner
  >();
  // Each project's approval policy is its persisted setting, which the
  // session reads at every decision through these following config stores:
  // a change any client writes applies to the next request, and nothing a
  // window holds can replace it.
  //
  // A project is its session and the scope its stores live in, leased by
  // the callers that use it. Opening, leasing and closing one run on the
  // project's lane, so a close sees every lease taken before it and an open
  // after it opens the project anew.
  interface Project {
    readonly session: SessionHandle;
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
        const session = yield* Effect.gen(function* () {
          const roots = yield* openRoots(root, projectScope);
          return yield* (yield* SessionOwner).open({
            roots,
            interruptedTasks: 'offer',
          });
        }).pipe(Effect.onError(() => Scope.close(projectScope, Exit.void)));
        project = { session, scope: projectScope, leases: 0, idleSince: 0 };
        projects.set(root, project);
      }
      project.leases += 1;
      return project;
    }).pipe(withPerKeyLane(lanes, root));
  const open = (workspace: string) => {
    const root = canonicalizeWorkspacePath(workspace);
    return Effect.acquireRelease(lease(root), (project) =>
      Effect.sync(() => {
        project.leases -= 1;
        if (project.leases === 0) project.idleSince = Date.now();
      }),
    ).pipe(
      Effect.map((project) => project.session),
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
      const now = Date.now();
      if (project.session.runs.heldIds().length > 0) {
        project.idleSince = now;
        return undefined;
      }
      if (now - project.idleSince < idleMs) return undefined;
      projects.delete(root);
      // The stores close even if the session's close fails.
      yield* (yield* SessionOwner)
        .close(project.session.roots.storage)
        .pipe(Effect.ensuring(Scope.close(project.scope, Exit.void)));
      return project.session;
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
        Effect.forEach([...projects.keys()], (root) =>
          closeIfIdle(root, Duration.toMillis(idleFor)),
        ),
        (closed) => closed.filter((session) => session !== undefined),
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
export function probeCliService(
  storageRoot: string,
): Effect.Effect<ServiceInfo | null, ServiceUnavailable> {
  return quietClient.pipe(Effect.andThen(probeRecordedService(storageRoot)));
}

/** `TEXRA_NO_SERVICE=1`: this process uses no background service, so a
 *  chat runs here, as where the service cannot run. */
const NO_SERVICE = 'TEXRA_NO_SERVICE';

/** Connect to the storage root's service, starting it when none answers
 *  and retiring one older than this build. Leaves the process's log sink as
 *  it is: what the chat uses. */
export function reachCliService(
  storageRoot: string,
): Effect.Effect<ServiceConnection, Error, Scope.Scope> {
  return withCliService(storageRoot, ensureService);
}

/** {@link reachCliService} held for the chat's life: the link reaches the
 *  service again when it goes away. */
export function linkCliService(
  storageRoot: string,
): Effect.Effect<ServiceLink, Error, Scope.Scope> {
  return withCliService(storageRoot, linkService);
}

/** `reach` over the storage root's service, started with this process's
 *  own Node and entry, unless `TEXRA_NO_SERVICE` is set. */
function withCliService<A>(
  storageRoot: string,
  reach: (
    storageRoot: string,
    start: Effect.Effect<void, Error>,
  ) => Effect.Effect<A, Error, Scope.Scope>,
): Effect.Effect<A, Error, Scope.Scope> {
  return Effect.flatMap(envFlag(NO_SERVICE), (off) =>
    off
      ? Effect.fail(new Error(`${NO_SERVICE} is set`))
      : reach(
          storageRoot,
          spawnService(storageRoot, process.execPath, [
            ...process.execArgv,
            readCliEntrypointPath(),
            'serve',
          ]),
        ),
  );
}

/**
 * Whether `owner`, the holder of a run's claim, is the storage root's
 * running service: a chat continues such a run through the service rather
 * than refusing it as held by another process.
 */
export function heldByService(
  storageRoot: string,
  owner: OwnerId,
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    if (yield* envFlag(NO_SERVICE)) return false;
    const info = yield* probeCliService(storageRoot).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          `The TeXRA service did not answer (${error.message}); a task it holds is treated as another process's`,
        ).pipe(Effect.as(null)),
      ),
    );
    if (info === null) return false;
    const { hostname: host, pid } = ownerIdentity(owner);
    return pid === info.pid && host.toLowerCase() === hostname().toLowerCase();
  });
}

/** {@link reachCliService} for a client command, whose process prints only
 *  its own result. */
export function connectCliService(
  storageRoot: string,
): Effect.Effect<ServiceConnection, Error, Scope.Scope> {
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
  function* (): Effect.fn.Return<string | null> {
    const own = (name: string) => cliEnvValue(name)?.trim() || undefined;
    const set = API_KEY_ENV_NAMES.filter((name) => own(name) !== undefined);
    if (set.length === 0) return null;
    // Best effort, for a notice only: a login shell that does not answer
    // leaves the service without those keys too.
    const login = yield* loginShellEnvironment(
      cliEnvValue('HOME') ?? homedir(),
    ).pipe(Effect.orElseSucceed((): Readonly<Record<string, string>> => ({})));
    const unseen = set.filter((name) => login[name]?.trim() !== own(name));
    if (unseen.length === 0) return null;
    const one = unseen.length === 1;
    return `${unseen.join(', ')} from this terminal ${one ? 'does' : 'do'} not reach tasks in the TeXRA service, which reads keys from \`texra setup\`, the project's .env and your login shell. Run with TEXRA_NO_SERVICE=1 to use this terminal's ${one ? 'key' : 'keys'}.`;
  },
);
