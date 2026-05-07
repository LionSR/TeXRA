import { COMMON_COMMANDS } from '@common/webview/commonCommands';
import { MAIN_VIEW_COMMANDS } from '@common/webview/mainViewCommands';
import { AGENT_CATEGORY, type AgentCategory } from '@shared/schemas/agent';
import {
  SwitchViewMessageSchema,
  type SwitchViewTarget,
} from '@shared/schemas/commonViewMessages';
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

function getAgentSettingsSubTab(message: DesktopCommandMessage) {
  return message.sessionType === AGENT_CATEGORY.TOOL_USE
    ? AGENT_CATEGORY.TOOL_USE
    : undefined;
}

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

  return {
    signIn,
    openAgentDirectory,
    openDesktopDocs,
    openLogFolder,
    openWorkspaceFolder,
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

export function createDesktopShellIpc(
  renderer: DesktopRenderer,
  options: DesktopShellIpcOptions = {},
): DesktopMessageHandler {
  const actions =
    options.actions != null
      ? options.actions
      : createDesktopShellActions(renderer, options);

  function postRouteForSwitchView(message: DesktopCommandMessage) {
    const result = SwitchViewMessageSchema.safeParse(message);
    if (!result.success) return;
    actions.showRoute(SWITCH_VIEW_ROUTES[result.data.view]);
  }

  return {
    handleMessage(message: DesktopCommandMessage): boolean {
      switch (message.command) {
        case COMMON_COMMANDS.SWITCH_VIEW:
          postRouteForSwitchView(message);
          return true;
        case MAIN_VIEW_COMMANDS.SETTINGS_OPEN:
          actions.showSettings();
          return true;
        case MAIN_VIEW_COMMANDS.OPEN_AGENT_SETTINGS:
          actions.showSettings(
            SETTINGS_TAB.AGENTS,
            getAgentSettingsSubTab(message),
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
    },
  };
}
