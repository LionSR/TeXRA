import { Data, Effect, FileSystem, type Path } from 'effect';

import { type MessageHost, NotificationFailed } from '@hosts/uiHosts';
import type { AgentDirectoriesFailed } from '@platform/interfaces';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { GlobalStorageFs } from '@platform/rootedFs';
import type { AgentCategory } from '@shared/schemas';
import type { SettingsTabPanelName } from '@shared/settingsView/settingsViewMessages';
import {
  DESKTOP_SHELL_COMMANDS,
  type DesktopLayoutPanel,
  type DesktopWorkbenchKind,
} from '../shared/desktopShellMessages.js';
import { buildDesktopOnboardingSetStateMessage } from '../shared/desktopOnboardingMessages.js';
import {
  DESKTOP_DOCS_URL,
  DESKTOP_SHELL_IPC_COMMANDS,
  dispatchDesktopCommand,
  postDesktopSettingsView,
  type DesktopCommandActions,
} from '../shared/desktopCommandSurface.js';
import type {
  DesktopCommandMessage,
  DesktopMessageHandler,
  DesktopRenderer,
} from './desktopIpcTypes.js';
import type { PreviewUnavailable } from './desktopPreviewHost.js';

/** A shell action's host call rejected. The window reports it and stays up. */
class ShellActionFailed extends Data.TaggedError('ShellActionFailed')<{
  readonly cause: unknown;
}> {}

/**
 * One host program on the shell's own failure channel: the value the reporter
 * formats is the one the member failed with.
 */
function onShellFailure<A, E, R>(
  program: Effect.Effect<A, E, R>,
): Effect.Effect<A, ShellActionFailed, R> {
  return program.pipe(
    Effect.mapError((cause) => new ShellActionFailed({ cause })),
  );
}

interface DesktopShellActionFactoryOptions extends Pick<
  MessageHost,
  'showInfoMessage'
> {
  getCustomAgentDirectory(): Effect.Effect<
    string,
    AgentDirectoriesFailed,
    GlobalStorageFs | FileSystem.FileSystem
  >;
  openExternalUrl(url: string): Effect.Effect<void, PreviewUnavailable>;
  openLogFolder(): Effect.Effect<void, PreviewUnavailable>;
  openPath(filePath: string): Effect.Effect<void, PreviewUnavailable>;
  openWorkspaceFolder(): Effect.Effect<
    void,
    unknown,
    FileSystem.FileSystem | Path.Path
  >;
  signIn(): Effect.Effect<void, unknown>;
  onAsyncError: (error: unknown) => void;
  /** The process runtime the composition root built; every shell action's
   *  program is forked on it rather than on a bare `Effect.run*`. */
  runtime: ProcessRuntime;
}

/**
 * The window's shell actions: what the native menu, the command palette,
 * and the host request arms reach the shell through.
 */
export interface DesktopShellActions extends DesktopCommandActions {
  signIn(): void;
  openAgentDirectory(customDirSet?: boolean): void;
  showInfoMessage(message: string): void;
}

export function createDesktopShellActions(
  renderer: DesktopRenderer,
  options: DesktopShellActionFactoryOptions,
): DesktopShellActions {
  const reportAsyncError = options.onAsyncError;

  /**
   * Shell actions are fire-and-forget: the program runs on its own fiber and
   * a host rejection reaches the window's async-error reporter with the
   * rejection value itself, which is what the reporter formats. The handler
   * names the whole channel, so a tag added to it fails to compile rather
   * than escaping the fork unreported.
   */
  function runShellAction(
    program: Effect.Effect<
      void,
      ShellActionFailed | NotificationFailed,
      GlobalStorageFs | FileSystem.FileSystem | Path.Path
    >,
  ): void {
    options.runtime.runFork(
      program.pipe(
        Effect.catch((failure: ShellActionFailed | NotificationFailed) =>
          Effect.sync(() => reportAsyncError(failure.cause)),
        ),
      ),
    );
  }

  function openWorkbench(kind: DesktopWorkbenchKind) {
    renderer.postToRenderer({
      command: DESKTOP_SHELL_COMMANDS.OPEN_WORKBENCH,
      kind,
    });
  }

  function showSettings(
    tab?: SettingsTabPanelName,
    agentSubTab?: AgentCategory,
  ) {
    postDesktopSettingsView(
      (message) => renderer.postToRenderer(message),
      tab,
      agentSubTab,
    );
  }

  const openCustomAgentDirectory = onShellFailure(
    Effect.flatMap(options.getCustomAgentDirectory(), (customDir) =>
      options.openPath(customDir),
    ),
  );

  function openAgentDirectory(customDirSet?: boolean) {
    if (customDirSet !== true) {
      showSettings('agents');
      return;
    }
    runShellAction(openCustomAgentDirectory);
  }

  // New Session is the header's "+" (PRD 12.4): the New-task state with
  // the launcher's selections as they are.
  function resetMainView() {
    renderer.postToRenderer({
      command: DESKTOP_SHELL_COMMANDS.SHOW_LAUNCHER,
    });
  }

  function toggleLayout(panel: DesktopLayoutPanel) {
    renderer.postToRenderer({
      command: DESKTOP_SHELL_COMMANDS.TOGGLE_LAYOUT,
      panel,
    });
  }

  return {
    signIn: () => runShellAction(onShellFailure(options.signIn())),
    openAgentDirectory,
    openDesktopDocs: () =>
      runShellAction(onShellFailure(options.openExternalUrl(DESKTOP_DOCS_URL))),
    openLogFolder: () =>
      runShellAction(onShellFailure(options.openLogFolder())),
    openWorkspaceFolder: () =>
      runShellAction(onShellFailure(options.openWorkspaceFolder())),
    saveFile: () => {
      renderer.postToRenderer({
        command: DESKTOP_SHELL_COMMANDS.SAVE_FILE,
      });
    },
    resetMainView,
    showLauncher: () => {
      renderer.postToRenderer({
        command: DESKTOP_SHELL_COMMANDS.SHOW_LAUNCHER,
      });
    },
    openWorkbench,
    showSettings,
    toggleBottomBar: () => toggleLayout('bottomBar'),
    toggleSidePanel: () => toggleLayout('sidePanel'),
    toggleSummaryBar: () => toggleLayout('summaryBar'),
    showFirstRunWalkthrough: () => {
      renderer.postToRenderer(buildDesktopOnboardingSetStateMessage(true));
    },
    showInfoMessage: (message) => {
      // The member is an Effect already failing with `NotificationFailed`, so
      // the action program is the member itself.
      runShellAction(options.showInfoMessage(message));
    },
  };
}

/**
 * The desktop-local commands the renderer posts by id (open log folder, the
 * walkthrough, the docs): they originate from the native menu's registry,
 * not from a session, so they dispatch through the one command registry the
 * menu also uses.
 */
export function createDesktopShellIpc(
  actions: DesktopShellActions,
): DesktopMessageHandler {
  return {
    handleMessage(message: DesktopCommandMessage): boolean {
      const id = DESKTOP_SHELL_IPC_COMMANDS.find(
        (candidate) => candidate === message.command,
      );
      if (id == null) return false;
      // Every registry handler runs its action synchronously and returns
      // `true`; `boolean | Promise<boolean>` is the shared dispatcher
      // signature, so narrow it here rather than widening this contract.
      return dispatchDesktopCommand(id, actions) === true;
    },
  };
}
