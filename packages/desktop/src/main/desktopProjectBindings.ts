// One binding per open project for a window (PRD 8.1, 12.2): the session
// bridge the renderer subscribes to, the project's `host` snapshot, its
// workspace transport and its presentation and launch path. Every open
// project is bound, not only the shown one: the rail lists them all from
// their own views. A binding is a scope: everything it holds is a finalizer
// of it, and releasing a project closes that scope, awaited.

import { Effect, Exit, Scope } from 'effect';

import type { HostDraftRequests } from '@controllers/session/hostDraftRequests';
import {
  createHostSnapshotSource,
  HostSnapshotReadFailed,
} from '@controllers/session/hostSnapshotSource';
import {
  SessionBridge,
  type AttachedPort,
} from '@controllers/session/SessionBridge';
import type { AgentDirectoriesPort } from '@platform/interfaces';
import {
  withProcessServices,
  type ProcessRuntime,
  type ProcessServices,
} from '@platform/processRuntime';
import type { PlatformSecrets } from '@platform/secrets';
import { ToolAvailability } from '@tools/toolAvailabilityService';
import {
  DESKTOP_WORKSPACE_COMMANDS,
  DesktopWorkspaceInboundMessageSchema,
  type DesktopWorkspaceReply,
} from '../shared/desktopWorkspaceMessages.js';
import {
  createDesktopAgentRun,
  type DesktopAgentRun,
} from './desktopAgentRun.js';
import {
  createDesktopBrowserViews,
  type DesktopBrowserViews,
} from './desktopBrowserViews.js';
import { createDesktopFileSelection } from './desktopFileSelection.js';
import { createDesktopHostRequests } from './desktopHostRequests.js';
import { createDesktopPtyHost } from './desktopPtyHost.js';
import { createDesktopWorkspaceIpc } from './desktopWorkspaceIpc.js';
import { desktopSpawner } from './desktopWindows.js';
import { parsedRoute, type DesktopCommandRoute } from './desktopIpcTypes.js';
import type { DesktopOnboardingIpc } from './desktopOnboardingIpc.js';
import type {
  DesktopProject,
  DesktopProjectRegistry,
} from './desktopProjects.js';
import type { DesktopWindowHost } from './desktopWindowHost.js';

export interface ProjectBinding {
  readonly project: DesktopProject;
  readonly bridge: SessionBridge;
  /** This window's port on the project's bridge. */
  readonly port: AttachedPort;
  readonly snapshot: ReturnType<typeof createHostSnapshotSource>;
  readonly run: DesktopAgentRun;
  readonly workspace: ReturnType<typeof createDesktopWorkspaceIpc>;
  readonly browserViews: DesktopBrowserViews;
  /** The binding's lifetime; closing it releases everything above. */
  readonly scope: Scope.Closeable;
}

export interface ProjectBindings {
  get(key: string): ProjectBinding | undefined;
  /** The binding of the project the window shows. */
  active(): ProjectBinding | undefined;
  all(): readonly ProjectBinding[];
  /** Run `op` on every binding's snapshot source. */
  eachSnapshot<E, R>(
    op: (snapshot: ProjectBinding['snapshot']) => Effect.Effect<void, E, R>,
  ): Effect.Effect<void, E, R>;
  /** Bind a project that opened and release one that closed. */
  readonly sync: Effect.Effect<void, never, ProcessServices>;
  /** Release every binding: a navigation destroys the document's request
   *  correlations and recording ownership, new ports on the same sessions. */
  readonly releaseAll: Effect.Effect<void>;
  /** Answer a project's workspace message (files, terminals, browser views).
   *  A closed project's request is dropped, not routed to a stranger. */
  readonly workspaceRoute: DesktopCommandRoute;
}

export interface ProjectBindingsOptions {
  readonly host: DesktopWindowHost;
  readonly runtime: ProcessRuntime;
  readonly projects: DesktopProjectRegistry;
  readonly secrets: PlatformSecrets;
  readonly agentDirectories: AgentDirectoriesPort;
  readonly resourcesPath: string;
  /** Recording has one process owner, shared by every project and window. */
  readonly draftRequests: HostDraftRequests;
  readonly onboarding: DesktopOnboardingIpc;
  readonly showFirstRunWalkthrough: () => void;
  /** Recompute the onboarding funnel when a launch settles. */
  readonly refreshFunnelAfterLaunch: Effect.Effect<void>;
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

    /** Each document/project owns one auxiliary transport and its resources.
     *  Callbacks capture the project before any asynchronous file or PTY work,
     *  and a released binding's late callbacks are dropped. */
    const createProjectWorkspace = (project: DesktopProject) => {
      let released = false;
      const post = (message: DesktopWorkspaceReply) =>
        !released && host.post({ ...message, session: project.key });
      const ptyHost = createDesktopPtyHost({
        cwd: () => project.root,
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
      const browserViews = createDesktopBrowserViews({
        getWindow: () => (host.window.isDestroyed() ? undefined : host.window),
        // Electron's window-open handler is the caller here, so the hand-off
        // runs at this arm rather than reaching the view as a program.
        openExternalUrl: (url) =>
          runtime.runPromise(host.previewHost.openExternal(url)),
        onNavigated: (state) =>
          post({ command: DESKTOP_WORKSPACE_COMMANDS.BROWSER_STATE, ...state }),
        onError: host.reportAsyncError,
        onBlockedExternalUrl: host.reportBackgroundError,
        onExternalOpenError: host.reportBackgroundError,
      });
      const workspace = createDesktopWorkspaceIpc(
        { postToRenderer: post },
        {
          ptyHost,
          browserViews,
          toWindowBounds: (bounds) => {
            const zoom = host.window.isDestroyed()
              ? 1
              : host.window.webContents.getZoomFactor();
            return {
              x: Math.round(bounds.x * zoom),
              y: Math.round(bounds.y * zoom),
              width: Math.round(bounds.width * zoom),
              height: Math.round(bounds.height * zoom),
            };
          },
          getWorkspacePath: () => project.root,
        },
      );
      return {
        workspace,
        browserViews,
        /** Stop posting, then release the terminals and browser views. */
        release: Effect.sync(() => {
          released = true;
          workspace.disposeRendererResources();
        }),
      };
    };

    const bindProject = Effect.fn('desktop.bindProject')(function* (
      project: DesktopProject,
    ) {
      const spawn = desktopSpawner(runtime, yield* Scope.Scope);
      const { workspace, browserViews, release } =
        createProjectWorkspace(project);
      const hosts = host.forProject(project);
      const files = createDesktopFileSelection({
        workspacePath: project.root,
        showOpenFileDialog: host.openFileDialog,
      });
      // The bridge drains the requests in flight, uninterruptibly, when it
      // closes, and a launch request lives as long as its run: a window that
      // closes must neither wait for a run to end nor stop it. So the bridge
      // has a scope of its own, closed off the window's release: the drain
      // ends after the window is gone, as the runs it waits on do, and its
      // answers, whose port is gone, are dropped.
      const bridgeScope = yield* Scope.make();
      yield* Effect.addFinalizer(() =>
        Effect.asVoid(Effect.forkDetach(Scope.close(bridgeScope, Exit.void))),
      );
      // Install the recipient before host requests publish the recorder's
      // state.
      const bridge = yield* SessionBridge.make({
        session: project.session,
        handleHostRequest: (request, portId) =>
          hostRequests.handleHostRequest(request, portId),
        onPortClosed: (portId) => hostRequests.closePort(portId),
      }).pipe(Scope.provide(bridgeScope));
      yield* Effect.forkScoped(workspace.followFilesWritten, {
        startImmediately: true,
      });
      const snapshot = createHostSnapshotSource({
        project: project.display,
        root: project.root,
        stores: project.session.roots,
        secrets: options.secrets,
        fileOptions: () =>
          files.fileOptions().pipe(
            Effect.mapError(
              (cause) =>
                new HostSnapshotReadFailed({
                  member: 'fileOptions',
                  message: 'The project file lists could not be read.',
                  cause,
                }),
            ),
          ),
        onError: host.reportBackgroundError,
        publish: (next) => bridge.setHost(next),
      });
      // The funnel is host state every open project's snapshot carries (8.1).
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          options.onboarding.onFunnelChange((state) =>
            snapshot.setOnboarding(state),
          ),
        ),
        (unsubscribe) => Effect.sync(unsubscribe),
      );
      const funnel = options.onboarding.funnelState();
      const initialSnapshot = funnel
        ? snapshot.setOnboarding(funnel).pipe(Effect.andThen(snapshot.refresh))
        : snapshot.refresh;
      const run = yield* createDesktopAgentRun({
        runtime,
        host: hosts.run,
        toolEditPreview: hosts.toolEditPreview,
        session: project.session,
        showAgentConfigBanner: ({ agentName, category }) =>
          withProcessServices(
            runtime,
            snapshot.showAgentConfigBanner(agentName, category),
          ),
        // A resolved agent also retires the missing-agent warning.
        onLaunched: (runId) => {
          bridge.surfaceAction({ kind: 'select', runId });
          spawn(snapshot.clearAgentConfigBanner);
        },
        // Recompute the onboarding funnel when a launch settles so a first
        // successful run leaves the setup card without a restart. The settled
        // launch includes AgentRunLifecycle's firstRunDone write.
        onRunCompleted: options.refreshFunnelAfterLaunch,
      });
      const hostRequests = createDesktopHostRequests({
        runtime,
        session: project.session,
        secrets: options.secrets,
        draftRequests: options.draftRequests,
        host: hosts.request,
        run,
        files,
        snapshot,
        workspacePath: project.root,
        resourcesPath: options.resourcesPath,
        postToRenderer: host.post,
        postSurfaceAction: (action) => bridge.surfaceAction(action),
        getCustomAgentDirectory: () => options.agentDirectories.custom(),
        showFirstRunWalkthrough: options.showFirstRunWalkthrough,
        onboarding: options.onboarding,
        openExternalUrl: host.openExternalUrl,
        recheckTools: () =>
          Effect.flatMap(ToolAvailability, (tools) =>
            Effect.asVoid(tools.refresh(project.roots)),
          ),
      });
      yield* Effect.addFinalizer(() => Effect.sync(hostRequests.dispose));
      // Registered after the host requests, so a port's release (its map
      // entry, its transcript set, `onPortClosed`) precedes their disposal, as
      // the extension's `dispose` orders them; awaited, unlike the bridge's.
      const port = yield* Effect.acquireRelease(
        bridge.attach({
          id: `window:${host.window.id}`,
          send: host.postSession,
        }),
        (attached) => attached.close,
      ).pipe(Effect.orDie);
      yield* Effect.addFinalizer(() => release);
      yield* Effect.forkScoped(initialSnapshot);
      return { project, bridge, port, snapshot, run, workspace, browserViews };
    });

    const bind = (project: DesktopProject) =>
      Effect.gen(function* () {
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

    const active = () => bindings.get(projects.active().key);

    return {
      get: (key) => bindings.get(key),
      active,
      all: () => [...bindings.values()],
      eachSnapshot: (op) =>
        Effect.forEach([...bindings.values()], (b) => op(b.snapshot), {
          concurrency: 'unbounded',
          discard: true,
        }),
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
            return Effect.sync(() =>
              console.warn(
                `Dropped a workspace request for closed project ${message.session}`,
              ),
            );
          }
          // Hidden projects retain their resources, but cannot cover the
          // visible project with a late browser-bounds notification.
          if (
            message.command === DESKTOP_WORKSPACE_COMMANDS.BROWSER_BOUNDS &&
            binding.project !== projects.active()
          )
            return Effect.void;
          return binding.workspace.handle(message);
        },
      ),
    };
  },
);
