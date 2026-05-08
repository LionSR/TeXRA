import { COMMON_COMMANDS } from '@common/webview/commonCommands';
import { MAIN_VIEW_COMMANDS } from '@common/webview/mainViewCommands';
import { AGENT_CATEGORY, type AgentCategory } from '@shared/schemas/agent';
import { type SwitchViewTarget } from '@shared/schemas/commonViewMessages';
import {
  MainViewInboundMessageSchema,
  type MainViewInboundMessage,
} from '@shared/schemas/mainView';
import {
  SETTINGS_TAB,
  type SettingsTab,
} from '@shared/schemas/settingsViewMessages';
import {
  DESKTOP_SHELL_COMMANDS,
  type DesktopRoute,
} from '../desktopShellMessages.js';
import { buildDesktopOnboardingSetStateMessage } from '../desktopOnboardingMessages.js';
import {
  createDesktopErrorReporter,
  type DesktopCommandMessage,
  type DesktopMessageHandler,
  type DesktopRenderer,
} from './desktopIpcTypes.js';
import {
  buildDesktopMainViewResetMessage,
  buildDesktopSettingsTabMessage,
  DESKTOP_DOCS_URL,
  DESKTOP_LOCAL_COMMANDS,
  type DesktopCommandActions,
} from '../desktopCommandSurface.js';

export type DesktopShellIpcOptions =
  | DesktopShellActionFactoryOptions
  | DesktopShellActionInstanceOptions;

export interface DesktopShellActionFactoryOptions {
  actions?: never;
  getCustomAgentDirectory?: () => Promise<string>;
  openExternalUrl?: (url: string) => Promise<void>;
  openLogFolder?: () => Promise<void>;
  openPath?: (filePath: string) => Promise<void>;
  openWorkspaceFolder?: () => Promise<void>;
  signIn?: () => Promise<void>;
  onAsyncError?: (error: unknown) => void;
}

export interface DesktopShellActionInstanceOptions {
  actions: DesktopShellActions;
  getCustomAgentDirectory?: never;
  openPath?: never;
  onAsyncError?: (error: unknown) => void;
}

export interface DesktopShellActions extends DesktopCommandActions {
  signIn(): void;
  openAgentDirectory(customDirSet?: boolean): void;
  setRecentCommitsUnavailable(): void;
}

const SWITCH_VIEW_ROUTES = {
  main: 'main',
  progress: 'progress',
  dashboard: 'settings',
} satisfies Record<SwitchViewTarget, DesktopRoute>;

export function createDesktopShellActions(
  renderer: DesktopRenderer,
  options: DesktopShellActionFactoryOptions = {},
): DesktopShellActions {
  const reportAsyncError = createDesktopErrorReporter(options.onAsyncError);

  function postRoute(route: DesktopRoute) {
    renderer.postToRenderer({
      command: DESKTOP_SHELL_COMMANDS.SET_ROUTE,
      route,
    });
  }

  function postSettingsRoute(
    tabIndex?: SettingsTab,
    agentSubTab?: AgentCategory,
  ) {
    postRoute('settings');
    if (tabIndex == null) return;
    renderer.postToRenderer(
      buildDesktopSettingsTabMessage(tabIndex, agentSubTab),
    );
  }

  async function openCustomAgentDirectory() {
    if (!options.getCustomAgentDirectory || !options.openPath) {
      postSettingsRoute(SETTINGS_TAB.AGENTS);
      return;
    }
    const customDir = await options.getCustomAgentDirectory();
    await options.openPath(customDir);
  }

  function openAgentDirectory(customDirSet?: boolean) {
    if (customDirSet !== true) {
      postSettingsRoute(SETTINGS_TAB.AGENTS);
      return;
    }
    void openCustomAgentDirectory().catch(reportAsyncError);
  }

  function openLogFolder() {
    void options.openLogFolder?.().catch(reportAsyncError);
  }

  function openWorkspaceFolder() {
    void options.openWorkspaceFolder?.().catch(reportAsyncError);
  }

  function openDesktopDocs() {
    void options.openExternalUrl?.(DESKTOP_DOCS_URL).catch(reportAsyncError);
  }

  function signIn() {
    if (!options.signIn) {
      postSettingsRoute(SETTINGS_TAB.MODELS);
      return;
    }
    void options.signIn().catch(reportAsyncError);
  }

  function resetMainView() {
    postRoute('main');
    renderer.postToRenderer(buildDesktopMainViewResetMessage());
  }

  return {
    signIn,
    openAgentDirectory,
    openDesktopDocs,
    openLogFolder,
    openWorkspaceFolder,
    resetMainView,
    setRecentCommitsUnavailable: () => {
      renderer.postToRenderer({
        command: MAIN_VIEW_COMMANDS.SET_RECENT_COMMITS,
        commits: [],
        isGitRepo: false,
      });
    },
    showRoute: postRoute,
    showSettings: postSettingsRoute,
    showFirstRunWalkthrough: () => {
      renderer.postToRenderer(buildDesktopOnboardingSetStateMessage(true));
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
    case COMMON_COMMANDS.SWITCH_VIEW:
      actions.showRoute(SWITCH_VIEW_ROUTES[message.view]);
      return true;
    case MAIN_VIEW_COMMANDS.SETTINGS_OPEN:
      actions.showSettings();
      return true;
    case MAIN_VIEW_COMMANDS.OPEN_AGENT_SETTINGS:
      actions.showSettings(
        SETTINGS_TAB.AGENTS,
        message.sessionType === AGENT_CATEGORY.TOOL_USE
          ? AGENT_CATEGORY.TOOL_USE
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
      actions.setRecentCommitsUnavailable();
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
      actions.openLogFolder?.();
      return true;
    case DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER:
      actions.openWorkspaceFolder?.();
      return true;
    case DESKTOP_LOCAL_COMMANDS.SHOW_FIRST_RUN_WALKTHROUGH:
      actions.showFirstRunWalkthrough?.();
      return true;
    case DESKTOP_LOCAL_COMMANDS.OPEN_DESKTOP_DOCS:
      actions.openDesktopDocs?.();
      return true;
    default:
      return false;
  }
}

export function createDesktopShellIpc(
  renderer: DesktopRenderer,
  options: DesktopShellIpcOptions = {},
): DesktopMessageHandler {
  const actions =
    options.actions != null
      ? options.actions
      : createDesktopShellActions(renderer, options);

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
