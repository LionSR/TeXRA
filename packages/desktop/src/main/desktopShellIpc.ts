import { Effect, type FileSystem, type Path } from 'effect';

import type { ProjectDatabases } from '@shared/session/database';
import type { SettingsTarget } from '@texra/shared/settingsView/settingsViewMessages';
import {
  DESKTOP_SHELL_COMMANDS,
  type DesktopLayoutPanel,
  type DesktopWorkbenchKind,
} from '../shared/desktopShellMessages.js';
import {
  DESKTOP_DOCS_URL,
  DESKTOP_SHELL_IPC_COMMANDS,
  dispatchDesktopCommand,
  postDesktopSettingsView,
  type DesktopCommandActions,
} from '../shared/desktopCommandSurface.js';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';
import type {
  DesktopCommandRoutes,
  DesktopRenderer,
} from './desktopIpcTypes.js';
import type { PreviewUnavailable } from './desktopPreviewHost.js';
import type { DesktopSpawn } from './desktopWindows.js';

interface DesktopShellActionFactoryOptions {
  openExternalUrl(url: string): Effect.Effect<void, PreviewUnavailable>;
  openLogFolder(): Effect.Effect<void, PreviewUnavailable>;
  openWorkspaceFolder(): Effect.Effect<
    void,
    Error,
    FileSystem.FileSystem | Path.Path | ProjectDatabases | ChildProcessSpawner
  >;
  /** The shown project's surfaces take the New-task state. */
  showLauncher(): void;
  onAsyncError: (error: unknown) => void;
  /** Every shell action's program runs on a fiber of the window's scope. */
  spawn: DesktopSpawn;
}

/**
 * The window's shell actions: what the native menu and the command palette
 * reach the shell through.
 */
export function createDesktopShellActions(
  renderer: DesktopRenderer,
  options: DesktopShellActionFactoryOptions,
): DesktopCommandActions {
  const reportAsyncError = options.onAsyncError;

  /**
   * Shell actions are fire-and-forget: the program runs on its own fiber and
   * whatever it fails with reaches the window's async-error reporter as is.
   */
  function runShellAction(
    program: Effect.Effect<
      void,
      Error,
      FileSystem.FileSystem | Path.Path | ProjectDatabases | ChildProcessSpawner
    >,
  ): void {
    options.spawn(
      program.pipe(
        Effect.catch((error) => Effect.sync(() => reportAsyncError(error))),
      ),
    );
  }

  function openWorkbench(kind: DesktopWorkbenchKind) {
    renderer.postToRenderer({
      command: DESKTOP_SHELL_COMMANDS.OPEN_WORKBENCH,
      kind,
    });
  }

  function showSettings(tab?: SettingsTarget) {
    postDesktopSettingsView((message) => renderer.postToRenderer(message), tab);
  }

  function toggleLayout(panel: DesktopLayoutPanel) {
    renderer.postToRenderer({
      command: DESKTOP_SHELL_COMMANDS.TOGGLE_LAYOUT,
      panel,
    });
  }

  return {
    openDesktopDocs: () =>
      runShellAction(options.openExternalUrl(DESKTOP_DOCS_URL)),
    openLogFolder: () => runShellAction(options.openLogFolder()),
    openWorkspaceFolder: () => runShellAction(options.openWorkspaceFolder()),
    saveFile: () => {
      renderer.postToRenderer({
        command: DESKTOP_SHELL_COMMANDS.SAVE_FILE,
      });
    },
    // New Task, the header's "+" (PRD 12.4): the New-task state with the
    // launcher's selections as they are, a surface action as the extension
    // sends it.
    showLauncher: options.showLauncher,
    openWorkbench,
    showSettings,
    toggleBottomBar: () => toggleLayout('bottomBar'),
    toggleSidePanel: () => toggleLayout('sidePanel'),
  };
}

/**
 * The desktop-local commands the renderer posts by id (open log folder, the
 * docs): they originate from the native menu's registry,
 * not from a session, so they dispatch through the one command registry the
 * menu also uses.
 */
export function createDesktopShellIpc(
  actions: DesktopCommandActions,
): DesktopCommandRoutes {
  // Every registry handler runs its action synchronously; an action that
  // forks host work reports its own failure.
  return Object.fromEntries(
    DESKTOP_SHELL_IPC_COMMANDS.map((id) => [
      id,
      () =>
        Effect.sync(() => {
          void dispatchDesktopCommand(id, actions);
        }),
    ]),
  );
}
