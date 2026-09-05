import type { MessageHost } from '@hosts/uiHosts';
import type { AgentCategory, SettingsTabPanelName } from '@shared/schemas';
import {
  DESKTOP_SHELL_COMMANDS,
  type DesktopLayoutPanel,
  type DesktopWorkbenchKind,
} from '../shared/desktopShellMessages.js';
import { buildDesktopOnboardingSetStateMessage } from '../shared/desktopOnboardingMessages.js';
import {
  createDesktopErrorReporter,
  type DesktopCommandMessage,
  type DesktopMessageHandler,
  type DesktopRenderer,
} from './desktopIpcTypes.js';
import {
  DESKTOP_DOCS_URL,
  DESKTOP_SHELL_IPC_COMMANDS,
  dispatchDesktopCommand,
  postDesktopSettingsView,
  type DesktopCommandActions,
} from '../shared/desktopCommandSurface.js';

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
  onAsyncError?: (error: unknown) => void;
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
  const reportAsyncError = createDesktopErrorReporter(options.onAsyncError);

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

  async function openCustomAgentDirectory() {
    const customDir = await options.getCustomAgentDirectory();
    await options.openPath(customDir);
  }

  function openAgentDirectory(customDirSet?: boolean) {
    if (customDirSet !== true) {
      showSettings('agents');
      return;
    }
    void openCustomAgentDirectory().catch(reportAsyncError);
  }

  function resetMainView() {
    renderer.postToRenderer({
      command: DESKTOP_SHELL_COMMANDS.SHOW_LAUNCHER,
    });
    renderer.postToRenderer({
      command: DESKTOP_SHELL_COMMANDS.RESET_LAUNCHER,
    });
  }

  function toggleLayout(panel: DesktopLayoutPanel) {
    renderer.postToRenderer({
      command: DESKTOP_SHELL_COMMANDS.TOGGLE_LAYOUT,
      panel,
    });
  }

  return {
    signIn: () => void options.signIn().catch(reportAsyncError),
    openAgentDirectory,
    openDesktopDocs: () =>
      void options.openExternalUrl(DESKTOP_DOCS_URL).catch(reportAsyncError),
    openLogFolder: () => void options.openLogFolder().catch(reportAsyncError),
    openWorkspaceFolder: () =>
      void options.openWorkspaceFolder().catch(reportAsyncError),
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
      void Promise.resolve(options.showInfoMessage(message)).catch(
        reportAsyncError,
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
