// One desktop window as a scoped program. Everything tied to the
// BrowserWindow (its fibers, its subscriptions, its project bindings and IPC
// listener) is a finalizer or a child of the scope it opens in; the scope's
// close is the window's teardown, awaited by whoever closes it (see
// `desktopWindows.ts`). Finalizers run in the reverse of their registration.

import { Effect, Scope, Semaphore, Stream, SubscriptionRef } from 'effect';
import { app, clipboard, dialog, Menu } from 'electron';
import { z } from 'zod';

import type { HostDraftRequests } from '@controllers/session/hostDraftRequests';
import type { AgentDirectoriesPort, StateStore } from '@platform/interfaces';
import type { ProcessRuntime, ProcessServices } from '@platform/processRuntime';
import type { PlatformSecrets } from '@platform/secrets';
import { DESKTOP_PROJECT_COMMANDS } from '../shared/desktopProjectMessages.js';
import { DESKTOP_WORKSPACE_INBOUND_COMMANDS } from '../shared/desktopWorkspaceMessages.js';
import {
  attachRendererConsoleLog,
  getDesktopLogDirectory,
  readDesktopLogSnapshot,
} from './desktopAppLog.js';
import {
  loadDesktopWindow,
  openDesktopBrowserWindow,
} from './desktopBrowserWindow.js';
import {
  isDesktopCommandMessage,
  type DesktopCommandRoute,
  type DesktopCommandRoutes,
} from './desktopIpcTypes.js';
import { createDesktopLogIpc } from './desktopLogIpc.js';
import { buildDesktopMenuTemplate } from './desktopMenuTemplate.js';
import { installDesktopNavigationPolicy } from './desktopNavigationPolicy.js';
import {
  openProjectBindings,
  type ProjectBindings,
} from './desktopProjectBindings.js';
import { createProjectNavigation } from './desktopProjectNavigation.js';
import { createDesktopProjectsIpc } from './desktopProjectsIpc.js';
import {
  openProjectSurface,
  type ProjectSurface,
} from './desktopProjectSurface.js';
import { DesktopPromptController } from './desktopPromptController.js';
import { SETTINGS_VIEW_INBOUND_COMMANDS } from './desktopSettingsIpc.js';
import {
  createDesktopShellActions,
  createDesktopShellIpc,
} from './desktopShellIpc.js';
import { checkForDesktopUpdate } from './desktopUpdateChecker.js';
import { openWindowOnboarding } from './desktopWindowOnboarding.js';
import { createDesktopWindowHost } from './desktopWindowHost.js';
import { bootstrapDesktopWindowLifecycle } from './desktopWindowLifecycle.js';
import { getDesktopWindowTitle } from './desktopWindowTitle.js';
import {
  desktopSpawner,
  type DesktopWindowHooks,
  type OpenedDesktopWindow,
} from './desktopWindows.js';
import { isFatalDesktopShutdownRequested } from './fatalStartupError.js';
import { installDesktopHostBridge } from './hostBridge.js';
import type {
  DesktopProjectRegistry,
  DesktopProjectsState,
} from './desktopProjects.js';

export interface DesktopWindowOptions {
  readonly projects: DesktopProjectRegistry;
  /** Recording has one process owner, shared by every project and window. */
  readonly draftRequests: HostDraftRequests;
  /** The process services the composition root built (see
   *  `ElectronPlatformInitResult`), handed down so the window's controllers
   *  and IPC surfaces take their stores from their owner rather than
   *  re-reading them. */
  readonly globalState: StateStore;
  readonly secrets: PlatformSecrets;
  readonly agentDirectories: AgentDirectoriesPort;
  /** See ElectronPlatformInitResult.resourcesPath. */
  readonly resourcesPath: string;
  /** See ElectronPlatformInitResult.mainDir. */
  readonly mainDir: string;
  /** The process runtime the composition root built. Every Effect this window
   *  runs settles on it. */
  readonly runtime: ProcessRuntime;
}

/** The one field every session message carries: which project it names. */
const SessionMessageEnvelopeSchema = z.object({ session: z.string() });

/** Opening is synchronous, as Electron's window creation is: see
 *  {@link DesktopWindows.open}. */
export const openDesktopWindow = Effect.fn('desktop.openWindow')(function* (
  options: DesktopWindowOptions,
  hooks: DesktopWindowHooks,
): Effect.fn.Return<OpenedDesktopWindow, never, Scope.Scope | ProcessServices> {
  const { runtime, projects } = options;
  const scope = yield* Scope.Scope;
  const spawn = desktopSpawner(runtime, scope);
  const initialProject = projects.active();
  const window = yield* openDesktopBrowserWindow({
    title: getDesktopWindowTitle(
      initialProject.session,
      initialProject.root && initialProject.display.name,
    ),
    mainDir: options.mainDir,
  });
  const host = createDesktopWindowHost({ window, runtime, spawn });
  const { previewHost } = host;
  const promptController = yield* Effect.acquireRelease(
    Effect.sync(
      () => new DesktopPromptController({ postToRenderer: host.post }),
    ),
    (controller) => Effect.sync(() => controller.dispose()),
  );
  attachRendererConsoleLog(window.webContents);
  installDesktopNavigationPolicy(window.webContents, {
    onAsyncError: host.reportAsyncError,
  });
  // Lightweight update check: at most once/day, notifies at most once per
  // release via a native dialog linking to the GitHub release page. Not a full
  // updater: no download, no install, no feed files. Disable with
  // TEXRA_NO_UPDATE_CHECK=1. Its dialog is this window's: a check still
  // running when the window closes stops with it, and the next window checks
  // again.
  spawn(
    checkForDesktopUpdate({
      currentVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      notify: host.announceRelease,
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => host.reportBackgroundError(error)),
      ),
    ),
  );

  // `surface`, `bindings` and `navigation` are declared below and read only
  // inside lazy callbacks; the order cannot flip, since the surface takes the
  // onboarding this call returns.
  const { onboarding, refreshFunnelAfterLaunch } = yield* openWindowOnboarding({
    host,
    runtime,
    projects,
    globalState: options.globalState,
    secrets: options.secrets,
    settings: () => surface.settings(),
    activeRun: () => bindings.active()?.run,
  });
  yield* refreshFunnelAfterLaunch;

  const shellActions = createDesktopShellActions(
    { postToRenderer: host.post },
    {
      openExternalUrl: previewHost.openExternal,
      openLogFolder: () => previewHost.openPath(getDesktopLogDirectory()),
      openWorkspaceFolder: () => navigation.openFolder(),
      showLauncher: () => {
        const attached = surface.attached();
        if (!attached) return;
        bindings.get(attached.key)?.bridge.surfaceAction({ kind: 'selectNew' });
      },
      onAsyncError: host.reportAsyncError,
      spawn,
    },
  );

  const bindings: ProjectBindings = yield* openProjectBindings({
    host,
    runtime,
    projects,
    secrets: options.secrets,
    agentDirectories: options.agentDirectories,
    resourcesPath: options.resourcesPath,
    draftRequests: options.draftRequests,
    onboarding,
    refreshFunnelAfterLaunch,
  });
  const surface: ProjectSurface = yield* openProjectSurface({
    host,
    runtime,
    projects,
    bindings,
    onboarding,
    promptController,
    secrets: options.secrets,
    resourcesPath: options.resourcesPath,
  });
  const navigation = createProjectNavigation({
    host,
    spawn,
    projects,
    bindings,
  });

  const postProjects = () => {
    const { projects: open, activeKey } = SubscriptionRef.getUnsafe(
      projects.state,
    );
    host.post({
      command: DESKTOP_PROJECT_COMMANDS.PROJECTS,
      open: open.flatMap(({ key, root }) => (root === undefined ? [] : [key])),
      activeKey,
    });
  };
  let menuRecent: readonly string[] | undefined;
  const installMenu = (recent: readonly string[]) => {
    if (recent === menuRecent) return;
    menuRecent = recent;
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        buildDesktopMenuTemplate(shellActions, {
          roots: recent,
          open: (root) => spawn(host.reported(navigation.open(root))),
          clear: () => spawn(host.reported(projects.clearRecent())),
        }),
      ),
    );
  };

  // The registry's changes and a navigation's reset both rebind the window's
  // projects and surface, and never overlap.
  const reconcileLane = yield* Semaphore.make(1);
  /** Follow the registry: bind a project that opened, release one that
   *  closed, and move the window's project-bound surfaces (settings, title)
   *  and the onboarding funnel, whose credential check reads the shown
   *  project's config, to the project it now shows. */
  const followProjects = (state: DesktopProjectsState) =>
    reconcileLane.withPermits(1)(
      Effect.gen(function* () {
        yield* bindings.sync;
        installMenu(state.recent);
        const switched = state.activeKey !== surface.attached()?.key;
        if (switched) {
          for (const binding of bindings.all()) binding.browserViews.hideAll();
        }
        yield* surface.attach();
        postProjects();
        if (switched) yield* refreshFunnelAfterLaunch;
      }),
    );
  /** A document reload destroys its request correlations (an open prompt
   *  answers undefined) and recording ownership: new ports, same sessions. */
  const resetForNewDocument = reconcileLane.withPermits(1)(
    Effect.gen(function* () {
      promptController.dispose();
      yield* bindings.releaseAll;
      yield* bindings.sync;
      yield* surface.attach(true);
    }),
  );

  // The renderer owns editor dirtiness. This event is the main process's only
  // reading of it: Chromium emits it after the renderer's beforeunload handler
  // observes a dirty Monaco buffer and refuses the unload, so every close path
  // (quit, document reload, window close) asks here and nowhere else.
  bootstrapDesktopWindowLifecycle({
    webContents: window.webContents,
    workspaceIpc: {
      disposeRendererResources: () => spawn(resetForNewDocument),
    },
    showDiscardDialog: host.showDiscardDialog,
    isFatalShutdownRequested: isFatalDesktopShutdownRequested,
    clearContinueQuitAfterWindowClose: hooks.cancelPendingQuit,
  });

  // One route per inbound command, each owned by one surface: the message's
  // `command` names the program that runs it.
  const claim = (
    commands: readonly string[],
    route: DesktopCommandRoute,
  ): DesktopCommandRoutes =>
    Object.fromEntries(commands.map((command) => [command, route]));
  const commandRoutes = new Map<string, DesktopCommandRoute>();
  for (const routes of [
    promptController.routes,
    claim(SETTINGS_VIEW_INBOUND_COMMANDS, (message) => {
      const settings = surface.settings();
      return settings
        ? settings.route(message)
        : Effect.sync(() =>
            console.warn(
              `Dropped ${message.command}: no project shows settings`,
            ),
          );
    }),
    claim(DESKTOP_WORKSPACE_INBOUND_COMMANDS, bindings.workspaceRoute),
    createDesktopProjectsIpc({
      postProjects,
      selectProject: navigation.select,
      closeProject: navigation.close,
    }),
    createDesktopLogIpc(
      { postToRenderer: host.post },
      {
        readLog: () =>
          readDesktopLogSnapshot({ workspacePath: projects.active().root }),
        copyLog: (text) => clipboard.writeText(text),
        showSaveDialog: (dialogOptions) =>
          dialog.showSaveDialog(window, dialogOptions),
      },
    ),
    createDesktopShellIpc(shellActions),
  ]) {
    for (const [command, route] of Object.entries(routes)) {
      if (commandRoutes.has(command)) {
        throw new Error(`Two desktop surfaces route ${command}`);
      }
      commandRoutes.set(command, route);
    }
  }
  const hostBridge = yield* Effect.acquireRelease(
    Effect.sync(() =>
      installDesktopHostBridge(window, {
        onCommand: (message) => {
          if (!isDesktopCommandMessage(message)) {
            console.warn('Dropped a renderer command with no command name');
            return;
          }
          const route = commandRoutes.get(message.command);
          if (!route) {
            console.warn(`Dropped ${message.command}: no surface routes it`);
            return;
          }
          // The one run site for every command's program, and its one
          // report: a failure or defect reaches the window's async-error
          // reporter.
          spawn(host.reported(route(message)));
        },
        // A session message names its project: that project's port answers
        // it.
        onSession: (message) => {
          const addressed = SessionMessageEnvelopeSchema.safeParse(message);
          if (!addressed.success) {
            console.warn('Dropped a session message with no session key');
            return;
          }
          const binding = bindings.get(addressed.data.session);
          if (!binding) {
            console.warn(
              `Dropped a renderer message for session ${addressed.data.session}: not open`,
            );
            return;
          }
          spawn(binding.port.receive(message));
        },
      }),
    ),
    (installed) => Effect.sync(() => installed.dispose()),
  );
  host.connectRenderer(hostBridge);
  yield* reconcileLane.withPermits(1)(
    Effect.andThen(bindings.sync, surface.attach()),
  );
  // Subscribed last: the first change it sees may bind a project, which
  // needs every window surface above. Its first element is the state just
  // attached, so it changes nothing.
  yield* Effect.forkScoped(
    Stream.runForEach(SubscriptionRef.changes(projects.state), (state) =>
      host.reported(followProjects(state)),
    ),
  );
  installMenu(SubscriptionRef.getUnsafe(projects.state).recent);

  loadDesktopWindow(window, options.mainDir);

  return { window, reveal: navigation.reveal };
});
