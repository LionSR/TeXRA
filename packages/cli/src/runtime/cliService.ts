/**
 * The CLI's side of the TeXRA service: the composition `texra serve` runs
 * (one session per project, opened on demand over that project's own roots,
 * as the desktop opens its folders), the detached start a client asks for
 * when no service answers, and the connection the chat TUI holds.
 */
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import * as path from 'node:path';

import {
  Effect,
  Scope,
  type Context,
  type FileSystem,
  type Path,
} from 'effect';

import { openSessionEffect, type SessionHandle } from '@agent/runtime';
import { bootstrapHost } from '@controllers/hostBootstrap';
import {
  openProjectStateStore,
  openRepoStateStore,
} from '@controllers/session/appStateStore';
import {
  ensureService,
  probeService,
  type ServiceConnection,
  type ServiceUnavailable,
} from '@controllers/server/client';
import {
  prepareServiceDirectories,
  servicePaths,
} from '@controllers/server/discovery';
import type { ServiceProjects } from '@controllers/server/handlers';
import type { ServiceInfo } from '@controllers/server/protocol';
import { createTexraResponseTextProcessing } from '@latex/texraResponseTextProcessing';
import { setLogSink, silentLogSink, writeLogLine } from '@logger/logSink';
import { JsonStore, nodeFileServices } from '@platform/defaults/jsonStore';
import { createNodeWorkspaceRoots } from '@platform/defaults/nodeHost';
import { TEXRA_CONFIG_FILE_NAME } from '@platform/defaults/nodeStorage';
import { openTexraWorkspaceConfigStores } from '@platform/defaults/nodeStores';
import { canonicalizeWorkspacePath } from '@platform/defaults/nodeWorkspace';
import {
  resolveGlobalStoragePath,
  resolveWorkspaceStoragePath,
} from '@platform/defaults/workspaceStorage';
import { AppState } from '@platform/interfaces';
import {
  TEXRA_APPROVAL_POLICY_CONFIG_KEY,
  type TexraApprovalPolicy,
} from '@shared/approvalPolicy';
import type {
  GlobalDatabase,
  ProjectDatabases,
} from '@shared/session/database';
import { readSettingFrom } from '@utils/config/platformSettings';
import { withPerKeyLane, type PerKeyLane } from '@utils/core/perKeyQueue';
import { ensureError } from '@utils/errors/errorMessage';

import { readCliEntrypointPath } from './cliContext';
import type { CliContext } from './cliContext';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

/** The log a detached service writes, beside its socket. */
export function serviceLogPath(storageRoot: string): string {
  return path.join(servicePaths(storageRoot).runDirectory, 'serve.log');
}

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
  const globalConfig = yield* JsonStore.open(
    path.join(globalStorage, TEXRA_CONFIG_FILE_NAME),
  );
  const warn = (message: string) => writeLogLine('WARN', 'cliService', message);
  const openRoots = Effect.fn('cliServiceProjects.openRoots')(function* (
    workspace: string | undefined,
  ) {
    const storage = resolveWorkspaceStoragePath(storageRoot, workspace);
    const [workspaceState, repoState, configs] = yield* Effect.all(
      [
        openProjectStateStore(storage, workspace),
        openRepoStateStore(workspace, storage),
        openTexraWorkspaceConfigStores(storage, workspace, warn),
      ],
      { concurrency: 'unbounded' },
    ).pipe(Scope.provide(scope));
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
    roots: yield* openRoots(undefined),
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
  >();
  const sessions = new Map<string, SessionHandle>();
  const lanes = new Map<string, PerKeyLane>();
  const open = (workspace: string) => {
    const root = canonicalizeWorkspacePath(workspace);
    return Effect.gen(function* () {
      const held = sessions.get(root);
      if (held !== undefined) return held;
      const roots = yield* openRoots(root);
      const session = yield* openSessionEffect({
        roots,
        responseTextProcessing: createTexraResponseTextProcessing(),
        interruptedTasks: 'offer',
      });
      session.setApprovalPolicy(
        yield* readSettingFrom<TexraApprovalPolicy>(
          roots,
          TEXRA_APPROVAL_POLICY_CONFIG_KEY,
        ),
      );
      // Notices a run raises while no window is attached are the service
      // log's: every client reads the task's state from its rows.
      yield* session.interactions.use({
        emit: (event, payload) =>
          Effect.logWarning(`Service notice ${event}`).pipe(
            Effect.annotateLogs({ data: payload }),
          ),
      });
      sessions.set(root, session);
      return session;
    }).pipe(
      withPerKeyLane(lanes, root),
      Effect.mapError(ensureError),
      Effect.provideContext(services),
    );
  };
  return {
    storageRoot,
    open,
    opened: Effect.sync(
      () =>
        new Map(
          [...sessions.values()].map((session) => [
            session.roots.storage,
            session,
          ]),
        ),
    ),
  } satisfies Context.Service.Shape<typeof ServiceProjects>;
});

/**
 * Start `texra serve` detached, with its output appended to the service
 * log, and return at once: the caller waits for its hello. It runs the
 * same entry and Node as this process.
 */
function startCliService(storageRoot: string): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const paths = servicePaths(storageRoot);
    yield* prepareServiceDirectories(paths);
    yield* Effect.try({
      try: () => {
        const log = openSync(serviceLogPath(storageRoot), 'a', 0o600);
        try {
          spawn(
            process.execPath,
            [...process.execArgv, readCliEntrypointPath(), 'serve'],
            {
              cwd: paths.runDirectory,
              detached: true,
              stdio: ['ignore', log, log],
            },
          ).unref();
        } finally {
          closeSync(log);
        }
      },
      catch: ensureError,
    });
  }).pipe(Effect.mapError(ensureError), Effect.provide(nodeFileServices));
}

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
  return quietClient.pipe(
    Effect.andThen(probeService(servicePaths(storageRoot).socket)),
  );
}

/** Connect to the storage root's service, starting it when none answers. */
export function connectCliService(
  storageRoot: string,
): Effect.Effect<ServiceConnection, Error, Scope.Scope> {
  return quietClient.pipe(
    Effect.andThen(ensureService(storageRoot, startCliService(storageRoot))),
  );
}
