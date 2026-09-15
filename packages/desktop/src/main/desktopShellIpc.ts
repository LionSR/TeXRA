import { Data, Effect } from 'effect';

import type { MessageHost } from '@hosts/uiHosts';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { AgentCategory, SettingsTabPanelName } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';
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

/** A shell action's host call rejected. The window reports it and stays up. */
class ShellActionFailed extends Data.TaggedError('ShellActionFailed')<{
  readonly cause: unknown;
  readonly message: string;
}> {}

/** One host call as a program: its rejection becomes the tagged failure. */
function hostCall<A>(
  call: () => Promise<A>,
): Effect.Effect<A, ShellActionFailed> {
  return Effect.tryPromise({
    try: call,
    catch: (cause) =>
      new ShellActionFailed({ cause, message: toErrorMessage(cause) }),
  });
}

interface DesktopShellActionFactoryOptions extends Pick<
  MessageHost,
  'showInfoMessage'
> {
  getCustomAgentDirectory(): Promise<string>;
  openExternalUrl(url: string): Promise<void>;
  openLogFolder(): Promise<void>;
  openPath(filePath: string): Promise<void>;
  openWorkspaceFolder(): Promise<void>;
  signIn(): Promise<void>;
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
   * rejection value itself, which is what the reporter formats.
   */
  function runShellAction(
    program: Effect.Effect<void, ShellActionFailed>,
  ): void {
    options.runtime.runFork(
      program.pipe(
        Effect.catchTag('ShellActionFailed', (failure) =>
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

  const openCustomAgentDirectory = Effect.gen(function* () {
    const customDir = yield* hostCall(() => options.getCustomAgentDirectory());
    yield* hostCall(() => options.openPath(customDir));
  });

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
    signIn: () => runShellAction(hostCall(() => options.signIn())),
    openAgentDirectory,
    openDesktopDocs: () =>
      runShellAction(hostCall(() => options.openExternalUrl(DESKTOP_DOCS_URL))),
    openLogFolder: () =>
      runShellAction(hostCall(() => options.openLogFolder())),
    openWorkspaceFolder: () =>
      runShellAction(hostCall(() => options.openWorkspaceFolder())),
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
      // The host member returns `Promise<void> | void`; awaiting it inside the
      // program covers both without a thenable assumption.
      runShellAction(
        hostCall(async () => {
          await options.showInfoMessage(message);
        }),
      );
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
