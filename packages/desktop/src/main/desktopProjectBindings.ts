// One binding per open project for a window: the session
// bridge the renderer subscribes to, the project's `host` snapshot, its
// workspace transport and its presentation and launch path. Every open
// project is bound, not only the shown one: the rail lists them all from
// their own views. A binding is a scope: everything it holds is a finalizer
// of it, and releasing a project closes that scope, awaited.

import { homedir } from 'node:os';

import { Effect, Exit, Queue, Scope, Stream, SubscriptionRef } from 'effect';

import type { ProcessRuntime, ProcessServices } from '@texra-ai/worldline/host';
import { logFailure, withLogChannel } from '@texra-ai/worldline/plugins';
import { fromHostSync } from '@texra/controllers/session/hostCallFailure';
import type { HostDraftRequests } from '@texra/controllers/session/hostDraftRequests';
import { openGuiWindow } from '@texra/controllers/session/openGuiWindow';
import type {
  AttachedPort,
  SessionBridge,
} from '@texra/controllers/session/SessionBridge';
import {
  DESKTOP_WORKSPACE_COMMANDS,
  DesktopWorkspaceInboundMessageSchema,
  type DesktopWorkspaceReply,
} from '../shared/desktopWorkspaceMessages.js';
import { createDesktopHostRequests } from './desktopHostRequests.js';
import { createDesktopPtyHost } from './desktopPtyHost.js';
import { DesktopToolEditApprovalHost } from './desktopToolEditApproval.js';
import { createDesktopWorkspaceIpc } from './desktopWorkspaceIpc.js';
import { desktopSpawner, type DesktopSpawn } from './desktopWindows.js';
import { parsedRoute, type DesktopCommandRoute } from './desktopIpcTypes.js';
import type { DesktopSettingsIpc } from './desktopSettingsIpc.js';
import type {
  DesktopProject,
  DesktopProjectRegistry,
} from './desktopProjects.js';
import type { DesktopWindowHost } from './desktopWindowHost.js';

interface ProjectBinding {
  readonly bridge: SessionBridge;
  /** This window's port on the project's bridge. */
  readonly port: AttachedPort;
  /** The settings view's verbs on the project's runs. */
  readonly workspace: ReturnType<typeof createDesktopWorkspaceIpc>;
  /** The binding's lifetime; closing it releases everything above. */
  readonly scope: Scope.Closeable;
}

export interface ProjectBindings {
  get(key: string): ProjectBinding | undefined;
  /** Bind a project that opened and release one that closed. */
  readonly sync: Effect.Effect<void, never, ProcessServices>;
  /** Release every binding: a navigation destroys the document's request
   *  correlations and recording ownership, new ports on the same sessions. */
  readonly releaseAll: Effect.Effect<void>;
  /** Answer a project's workspace message (files, terminals).
   *  A closed project's request is dropped, not routed to a stranger. */
  readonly workspaceRoute: DesktopCommandRoute;
}

interface ProjectBindingsOptions {
  readonly host: DesktopWindowHost;
  readonly runtime: ProcessRuntime;
  readonly projects: DesktopProjectRegistry;
  /** Recording has one process owner, shared by every project and window. */
  readonly draftRequests: HostDraftRequests;
  /** The window's settings surface, built after these bindings and absent
   *  while the window switches projects. */
  readonly settings: () => DesktopSettingsIpc | undefined;
}

export const openProjectBindings = Effect.fn('desktop.openProjectBindings')(
  function* (
    options: ProjectBindingsOptions,
  ): Effect.fn.Return<ProjectBindings, never, Scope.Scope> {
    const { host, runtime, projects } = options;
    // Registered here, so the window's close releases the bindings after the
    // surfaces registered later (its IPC listener among them) have stopped.
    const bindingsScope = yield* Scope.fork(yield* Scope.Scope);
    const bindings = new Map<string, ProjectBinding>();

    /** Where a project's terminal opens, decided once: the project's folder;
     *  for the no-workspace session the home directory, not the app's own
     *  process cwd (`/` when launched from the dock). `os.homedir()` throws
     *  where no home can be determined (some containers and remote hosts);
     *  only then does the process cwd stand, and the warning says why. */
    const terminalCwd = (root: string | undefined): Effect.Effect<string> =>
      root !== undefined
        ? Effect.succeed(root)
        : fromHostSync('homedir', homedir).pipe(
            Effect.catch((error) =>
              logFailure(
                'desktop',
                'No home directory could be determined; the terminal opens in the app directory.',
              )(error.cause).pipe(Effect.as(process.cwd())),
            ),
          );
    /** Each document/project owns one auxiliary transport and its resources.
     *  Callbacks capture the project before any asynchronous file or PTY work,
     *  and a released binding's late callbacks are dropped. */
    const createProjectWorkspace = (
      project: DesktopProject,
      spawn: DesktopSpawn,
      cwd: string,
    ) => {
      let released = false;
      const post = (message: DesktopWorkspaceReply) =>
        !released && host.post({ ...message, session: project.key });
      const ptyHost = createDesktopPtyHost({
        cwd,
        onData: (sessionId, data) =>
          post({
            command: DESKTOP_WORKSPACE_COMMANDS.TERMINAL_DATA,
            sessionId,
            data,
          }),
        onExit: (sessionId, exitCode) =>
          post({
            command: DESKTOP_WORKSPACE_COMMANDS.TERMINAL_EXIT,
            sessionId,
            exitCode,
          }),
        onError: host.reportBackgroundError,
      });
      const workspace = createDesktopWorkspaceIpc(post, { ptyHost });
      return {
        workspace,
        /** Stop posting, then release the terminals. */
        release: Effect.sync(() => {
          released = true;
          workspace.disposeRendererResources();
        }),
      };
    };

    const bindProject = Effect.fn('desktop.bindProject')(function* (
      project: DesktopProject,
    ) {
      const spawn = desktopSpawner(
        runtime,
        yield* Scope.Scope,
        project.roots.workspace,
      );
      const { workspace, release } = createProjectWorkspace(
        project,
        spawn,
        yield* terminalCwd(project.roots.workspace),
      );
      const hosts = host.forProject(project);
      // The window's focus, told to the service as a VS Code window's is:
      // the project's host calls go to the window the user last worked in.
      // The window shows one project at a time, so only that project's
      // binding reports its focus, and a project shown while the window is
      // focused reports it then.
      const shown = () =>
        SubscriptionRef.getUnsafe(projects.state).activeKey === project.key;
      const focused = Stream.merge(
        Stream.callback<void>((queue) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              const onFocus = () => {
                if (shown()) Queue.offerUnsafe(queue, undefined);
              };
              host.window.on('focus', onFocus);
              if (host.window.isFocused()) onFocus();
              return onFocus;
            }),
            (onFocus) =>
              Effect.sync(() => {
                if (!host.window.isDestroyed())
                  host.window.off('focus', onFocus);
              }),
          ),
        ),
        SubscriptionRef.changes(projects.state).pipe(
          Stream.map((state) => state.activeKey === project.key),
          Stream.changes,
          Stream.filter((isShown) => isShown && host.window.isFocused()),
          Stream.map(() => undefined),
        ),
      );
      const gui = yield* openGuiWindow({
        runs: project,
        roots: project.roots,
        project: project.display,
        // The desktop shows the credential in Settings.
        snapshot: {
          workspaceRoots: () => [],
          setupNotices: false,
        },
        // The tool-edit preview: staged copies of the original and proposed
        // content the review pane diffs, for each tool edit the project's
        // session lists, here or in the service.
        toolEdits: new DesktopToolEditApprovalHost({
          ui: {
            ...hosts.toolEditPreview,
            notify: hosts.run.notify,
          },
          spawn,
          focused: () => shown() && host.window.isFocused(),
        }),
        focused,
        draftRequests: options.draftRequests,
        host: createDesktopHostRequests({
          host: hosts.run,
          runtime,
          openFiles: host.openFileDialog,
          postToRenderer: host.post,
          settings: options.settings,
          openExternalUrl: host.openExternalUrl,
        }),
      });
      const { bridge, snapshot } = gui;
      yield* Effect.forkScoped(
        Stream.runForEach(snapshot.filesWritten, () => workspace.filesChanged),
        { startImmediately: true },
      );
      // Registered after the host requests, so a port's release (its map
      // entry, its transcript set, `onPortClosed`) precedes their release, as
      // the extension's `dispose` orders them; awaited, unlike the bridge's.
      const port = yield* Effect.acquireRelease(
        bridge.attach({
          id: `window:${host.window.id}`,
          send: host.postSession,
        }),
        (attached) => attached.close,
      ).pipe(Effect.orDie);
      yield* Effect.addFinalizer(() => release);
      yield* Effect.forkScoped(snapshot.refresh);
      return { bridge, port, workspace };
    });

    const bind = Effect.fn('bind')(function* (project: DesktopProject) {
      const scope = yield* Scope.fork(bindingsScope);
      const binding = yield* bindProject(project).pipe(
        Scope.provide(scope),
        Effect.onError(() => Scope.close(scope, Exit.void)),
      );
      return { ...binding, scope };
    });
    const release = (binding: ProjectBinding) =>
      Scope.close(binding.scope, Exit.void);

    const releaseAll = Effect.suspend(() => {
      const open = [...bindings.values()];
      bindings.clear();
      return Effect.forEach(open, release, { discard: true });
    });
    yield* Effect.addFinalizer(() => releaseAll);

    return {
      get: (key) => bindings.get(key),
      sync: Effect.gen(function* () {
        const open = new Map(
          [projects.fallback(), ...projects.list()].map(
            (project) => [project.key, project] as const,
          ),
        );
        for (const [key, binding] of bindings) {
          if (open.has(key)) continue;
          bindings.delete(key);
          yield* release(binding);
        }
        for (const [key, project] of open) {
          if (bindings.has(key)) continue;
          bindings.set(key, yield* bind(project));
        }
      }),
      releaseAll,
      workspaceRoute: parsedRoute(
        DesktopWorkspaceInboundMessageSchema,
        (message) => {
          const binding = bindings.get(message.session);
          if (!binding) {
            return Effect.logWarning(
              `Dropped a workspace request for closed project ${message.session}`,
            ).pipe(withLogChannel('desktop'));
          }
          return binding.workspace.handle(message);
        },
      ),
    };
  },
);
