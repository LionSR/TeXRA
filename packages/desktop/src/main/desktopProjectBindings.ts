// One binding per open project for a window (PRD 8.1, 12.2): the session
// bridge the renderer subscribes to, the project's `host` snapshot, its
// workspace transport and its presentation and launch path. Every open
// project is bound, not only the shown one: the rail lists them all from
// their own views. A binding is a scope: everything it holds is a finalizer
// of it, and releasing a project closes that scope, awaited.

import {
  Cause,
  Effect,
  Exit,
  Layer,
  Queue,
  Scope,
  Stream,
  SubscriptionRef,
} from 'effect';

import {
  withProcessServices,
  workspaceEnvironmentLayer,
  type ProcessRuntime,
  type ProcessServices,
} from '@texra-ai/harness';
import type { HostDraftRequests } from '@texra/controllers/session/hostDraftRequests';
import {
  createHostSnapshotSource,
  HostSnapshotReadFailed,
} from '@texra/controllers/session/hostSnapshotSource';
import {
  SessionBridge,
  type AttachedPort,
} from '@texra/controllers/session/SessionBridge';
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
import type { PlatformSecrets, AgentDirectoriesPort } from '@texra-ai/harness';
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
  /** The project's `.env` over the process's: every question about this
   *  project's models (its catalogs, its banners) is answered under it. */
  readonly env: Layer.Layer<never>;
  /** The binding's lifetime; closing it releases everything above. */
  readonly scope: Scope.Closeable;
}

export interface ProjectBindings {
  get(key: string): ProjectBinding | undefined;
  /** The binding of the project the window shows. */
  active(): ProjectBinding | undefined;
  all(): readonly ProjectBinding[];
  /** Run `op` on every binding's snapshot source, each under its project's
   *  own environment. */
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
      const spawn = desktopSpawner(runtime, yield* Scope.Scope, project.root);
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
        backend: project.backend,
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
      // The service link's state: offline while it reaches the service
      // again, so the window never sits frozen without saying why.
      const service = project.service;
      if (service !== undefined)
        yield* Effect.forkScoped(
          Stream.runForEach(SubscriptionRef.changes(service.client), (client) =>
            snapshot.setServiceOffline(client === null),
          ),
        );
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
      // The window's focus, told to the service as a VS Code window's is:
      // the project's host calls go to the window the user last worked in.
      const focused = Stream.callback<void>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const onFocus = () => Queue.offerUnsafe(queue, undefined);
            host.window.on('focus', onFocus);
            if (host.window.isFocused()) onFocus();
            return onFocus;
          }),
          (onFocus) =>
            Effect.sync(() => {
              if (!host.window.isDestroyed()) host.window.off('focus', onFocus);
            }),
        ),
      );
      const run = yield* createDesktopAgentRun({
        runtime,
        host: hosts.run,
        toolEditPreview: hosts.toolEditPreview,
        session: project.session,
        backend: project.backend,
        service: project.service,
        root: project.root,
        focused,
        showAgentConfigBanner: ({ agentName }) =>
          withProcessServices(
            runtime,
            snapshot.showAgentConfigBanner(agentName),
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
        backend: project.backend,
        secrets: options.secrets,
        draftRequests: options.draftRequests,
        workspaceFile: workspace.file,
        host: hosts.request,
        run,
        files,
        snapshot,
        workspacePath: project.root,
        resourcesPath: options.resourcesPath,
        postToRenderer: host.post,
        postSurfaceAction: (action) => bridge.surfaceAction(action),
        getCustomAgentDirectory: () => options.agentDirectories.custom(),
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
      const env = workspaceEnvironmentLayer(project.root);
      yield* Effect.forkScoped(Effect.provide(initialSnapshot, env));
      return {
        project,
        bridge,
        port,
        snapshot,
        run,
        workspace,
        browserViews,
        env,
      };
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
        Effect.forEach(
          [...bindings.values()],
          // One project's failure (its unreadable `.env`) is that project's:
          // logged, and never stops the others' refresh.
          (b) =>
            Effect.provide(op(b.snapshot), b.env).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.failCause(cause)
                  : Effect.logWarning(
                      `The project ${b.project.root ?? b.project.key} did not refresh: ${Cause.pretty(cause)}`,
                    ),
              ),
            ),
          {
            concurrency: 'unbounded',
            discard: true,
          },
        ),
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
