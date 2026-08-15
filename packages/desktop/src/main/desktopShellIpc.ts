import { COMMON_COMMANDS, MAIN_VIEW_COMMANDS } from '@shared/ipc';
import type { MainViewInboundMessage, SettingsTab } from '@shared/schemas';
import {
  AgentCategory,
  MainViewInboundMessageSchema,
  SETTINGS_TAB,
} from '@shared/schemas';
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
  buildDesktopMainViewResetMessage,
  DESKTOP_DOCS_URL,
  DESKTOP_LOCAL_COMMANDS,
  postDesktopSettingsView,
  vsCodeOnlyGettingStartedMessage,
  type DesktopCommandActions,
} from '../shared/desktopCommandSurface.js';

export interface DesktopShellActionFactoryOptions {
  getCustomAgentDirectory(): Promise<string>;
  openExternalUrl(url: string): Promise<void>;
  openLogFolder(): Promise<void>;
  openPath(filePath: string): Promise<void>;
  openWorkspaceFolder(): Promise<void>;
  signIn(): Promise<void>;
  /**
   * Async git log host. The shell forwards its recent-commit result to the
   * renderer. The host converts expected git failures into an empty result
   * with its best-effort `isGitRepo` value.
   */
  getRecentCommits(): Promise<{
    commits: string[];
    isGitRepo: boolean;
  }>;
  showInfoMessage(message: string): Promise<void> | void;
  onAsyncError?: (error: unknown) => void;
}

export interface DesktopShellActions extends DesktopCommandActions {
  signIn(): void;
  openAgentDirectory(customDirSet?: boolean): void;
  /**
   * Posts the most recent git commits to the renderer in response to
   * `MAIN_VIEW_COMMANDS.REQUEST_RECENT_COMMITS`.
   */
  sendRecentCommits(): void;
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

  function showSettings(tabIndex?: SettingsTab, agentSubTab?: AgentCategory) {
    postDesktopSettingsView(
      (message) => renderer.postToRenderer(message),
      tabIndex,
      agentSubTab,
    );
  }

  async function openCustomAgentDirectory() {
    const customDir = await options.getCustomAgentDirectory();
    await options.openPath(customDir);
  }

  function openAgentDirectory(customDirSet?: boolean) {
    if (customDirSet !== true) {
      showSettings(SETTINGS_TAB.AGENTS);
      return;
    }
    void openCustomAgentDirectory().catch(reportAsyncError);
  }

  function resetMainView() {
    renderer.postToRenderer({
      command: DESKTOP_SHELL_COMMANDS.SHOW_LAUNCHER,
    });
    renderer.postToRenderer(buildDesktopMainViewResetMessage());
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
    sendRecentCommits: () => {
      const postReply = (commits: string[], isGitRepo: boolean) => {
        renderer.postToRenderer({
          command: MAIN_VIEW_COMMANDS.SET_RECENT_COMMITS,
          commits,
          isGitRepo,
        });
      };
      void options
        .getRecentCommits()
        .then(({ commits, isGitRepo }) => postReply(commits, isGitRepo))
        .catch((error) => {
          // The git host swallows expected errors; reaching this catch is a
          // programmer bug. Log and send a conservative reply so the launcher
          // banner does not hang.
          reportAsyncError(error);
          postReply([], false);
        });
    },
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
 * Dispatch a fully-validated `MainViewInboundMessage` against the shell
 * actions. The discriminated-union narrowing means each case sees a
 * fully-typed payload — no per-handler `safeParse` calls are needed.
 *
 * Returns `true` when the message was claimed by a shell handler, `false`
 * when the variant is recognised by the schema but has no shell mapping
 * (e.g. EXECUTE, file-selection, banner toggles — those are handled by
 * sibling IPC adapters in the dispatcher chain).
 */
function dispatchMainViewInboundOnShell(
  message: MainViewInboundMessage,
  actions: DesktopShellActions,
): boolean {
  switch (message.command) {
    case COMMON_COMMANDS.SWITCH_VIEW: {
      switch (message.view) {
        case 'main':
          actions.showLauncher();
          break;
        case 'dashboard':
          actions.showSettings();
          break;
        case 'progress':
          // The conversation is the permanent desktop canvas, so progress is
          // already visible and intentionally needs no action.
          break;
        default:
          message.view satisfies never;
      }
      return true;
    }
    case MAIN_VIEW_COMMANDS.OPEN_AGENT_SETTINGS:
      actions.showSettings(
        SETTINGS_TAB.AGENTS,
        message.sessionType === AgentCategory.ToolUse
          ? AgentCategory.ToolUse
          : undefined,
      );
      return true;
    case MAIN_VIEW_COMMANDS.OPEN_MODEL_SETTINGS:
      actions.showSettings(SETTINGS_TAB.MODELS);
      return true;
    case MAIN_VIEW_COMMANDS.SIGN_IN_FROM_BANNER:
      actions.signIn();
      return true;
    case MAIN_VIEW_COMMANDS.OPEN_SET_API_KEY:
    case MAIN_VIEW_COMMANDS.OPEN_SET_PROVIDER_API_KEY:
      actions.showSettings(SETTINGS_TAB.MODELS);
      return true;
    case MAIN_VIEW_COMMANDS.OPEN_MULTI_AGENT_SETTINGS:
      actions.showSettings(SETTINGS_TAB.MULTI_AGENT);
      return true;
    case MAIN_VIEW_COMMANDS.OPEN_AGENT_DIRECTORY:
      actions.openAgentDirectory(message.customDirSet === true);
      return true;
    case MAIN_VIEW_COMMANDS.REQUEST_RECENT_COMMITS:
      actions.sendRecentCommits();
      return true;
    case MAIN_VIEW_COMMANDS.GETTING_STARTED_ACTION:
      if (message.action === 'openWalkthrough') {
        actions.showFirstRunWalkthrough();
      } else {
        actions.showInfoMessage(
          vsCodeOnlyGettingStartedMessage(message.action),
        );
      }
      return true;
    default:
      return false;
  }
}

function dispatchDesktopLocalOnShell(
  message: DesktopCommandMessage,
  actions: DesktopShellActions,
): boolean {
  switch (message.command) {
    case DESKTOP_LOCAL_COMMANDS.OPEN_LOG_FOLDER:
      actions.openLogFolder();
      return true;
    case DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER:
      actions.openWorkspaceFolder();
      return true;
    case DESKTOP_LOCAL_COMMANDS.SHOW_FIRST_RUN_WALKTHROUGH:
      actions.showFirstRunWalkthrough();
      return true;
    case DESKTOP_LOCAL_COMMANDS.OPEN_DESKTOP_DOCS:
      actions.openDesktopDocs();
      return true;
    default:
      return false;
  }
}

export function createDesktopShellIpc(
  actions: DesktopShellActions,
): DesktopMessageHandler {
  return {
    handleMessage(message: DesktopCommandMessage): boolean {
      // Single discriminated-union parse at the entry point. Every shell
      // case below operates on the narrowed variant — no scattered
      // per-handler `safeParse` calls.
      const parsed = MainViewInboundMessageSchema.safeParse(message);
      if (parsed.success) {
        return dispatchMainViewInboundOnShell(parsed.data, actions);
      }
      // Desktop-local commands (open log folder, walkthrough, docs) are
      // not part of the main-view inbound union — they originate from the
      // native menu, not the renderer schema — so they are handled
      // separately as a fallback after the union parse fails.
      return dispatchDesktopLocalOnShell(message, actions);
    },
  };
}
