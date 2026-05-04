import { nativeTheme, type BrowserWindow } from 'electron';

import { COMMON_COMMANDS } from '@common/webview/commonCommands';
import { MAIN_VIEW_COMMANDS } from '@common/webview/mainViewCommands';
import { SETTINGS_VIEW_COMMANDS } from '@common/webview/settingsViewCommands';
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
import {
  installDesktopHostBridge,
  type DesktopHostBridge,
} from './hostBridge.js';
import type { MainViewExecuteMessage } from '@controllers/mainView/MainViewExecutionController';
import type { DesktopFileSelection } from './desktopFileSelection.js';
import type { DesktopSettingsIpc } from './desktopSettingsIpc.js';

type DesktopTheme = 'dark' | 'light' | 'high-contrast';

export interface DesktopMainViewIpcOptions {
  debugMode?: boolean;
  getTheme?: () => DesktopTheme;
  getCustomAgentDirectory?: () => Promise<string>;
  openPath?: (filePath: string) => Promise<void>;
  fileSelection?: DesktopFileSelection;
  settings?: DesktopSettingsIpc;
  executeAgent?: (message: MainViewExecuteMessage) => Promise<void>;
  onAsyncError?: (error: unknown) => void;
}

export interface DesktopMainViewIpc {
  postToRenderer(message: unknown): void;
  dispose(): void;
}

function isMessageWithCommand(
  message: unknown,
): message is { command: string } {
  return (
    typeof message === 'object' &&
    message !== null &&
    'command' in message &&
    typeof message.command === 'string'
  );
}

function getNativeTheme(): DesktopTheme {
  if (nativeTheme.shouldUseHighContrastColors) return 'high-contrast';
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

function getAgentSettingsSubTab(message: unknown): AgentCategory | undefined {
  if (
    typeof message === 'object' &&
    message !== null &&
    'sessionType' in message &&
    message.sessionType === AGENT_CATEGORY.TOOL_USE
  ) {
    return AGENT_CATEGORY.TOOL_USE;
  }
  return undefined;
}

const SWITCH_VIEW_ROUTES = {
  main: 'main',
  progress: 'progress',
  dashboard: 'settings',
} satisfies Record<SwitchViewTarget, DesktopRoute>;

export function installDesktopMainViewIpc(
  window: BrowserWindow,
  options: DesktopMainViewIpcOptions = {},
): DesktopMainViewIpc {
  const getTheme = options.getTheme ?? getNativeTheme;
  const debugMode = options.debugMode ?? false;

  let disposed = false;

  function postTheme() {
    bridge.postToRenderer({
      command: COMMON_COMMANDS.THEME_SET,
      theme: getTheme(),
    });
  }
  function postDebugMode() {
    bridge.postToRenderer({
      command: COMMON_COMMANDS.DEBUG_MODE_SET,
      debugMode,
    });
  }
  function postRoute(route: DesktopRoute) {
    bridge.postToRenderer({
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
    bridge.postToRenderer({
      command: SETTINGS_VIEW_COMMANDS.SET_TAB,
      tabIndex,
      ...(agentSubTab && { agentSubTab }),
    });
  }
  function postRouteForSwitchView(message: unknown) {
    const result = SwitchViewMessageSchema.safeParse(message);
    if (!result.success) return;
    postRoute(SWITCH_VIEW_ROUTES[result.data.view]);
  }
  function reportAsyncError(error: unknown) {
    if (options.onAsyncError) {
      options.onAsyncError(error);
      return;
    }
    console.error(error);
  }
  async function openCustomAgentDirectory() {
    if (!options.getCustomAgentDirectory || !options.openPath) {
      postSettingsRoute(SETTINGS_TAB.AGENTS);
      return;
    }
    const customDir = await options.getCustomAgentDirectory();
    await options.openPath(customDir);
  }
  function handleOpenAgentDirectory(message: unknown) {
    const customDirSet =
      typeof message === 'object' &&
      message !== null &&
      'customDirSet' in message &&
      message.customDirSet === true;
    if (!customDirSet) {
      postSettingsRoute(SETTINGS_TAB.AGENTS);
      return;
    }
    void openCustomAgentDirectory().catch(reportAsyncError);
  }
  function handleExecute(message: unknown) {
    if (!options.executeAgent) return;
    void options
      .executeAgent(message as MainViewExecuteMessage)
      .catch(reportAsyncError);
  }
  function postInitialState() {
    postTheme();
    postDebugMode();
  }
  function handleRendererMessage(message: unknown) {
    if (!isMessageWithCommand(message)) return;
    if (options.fileSelection?.handleMessage(message)) return;
    if (options.settings?.handleMessage(message)) return;

    switch (message.command) {
      case MAIN_VIEW_COMMANDS.WEBVIEW_READY:
        postInitialState();
        break;
      case MAIN_VIEW_COMMANDS.GET_THEME:
        postTheme();
        break;
      case MAIN_VIEW_COMMANDS.GET_DEBUG_MODE:
        postDebugMode();
        break;
      case COMMON_COMMANDS.SWITCH_VIEW:
        postRouteForSwitchView(message);
        break;
      case MAIN_VIEW_COMMANDS.SETTINGS_OPEN:
        postSettingsRoute();
        break;
      case MAIN_VIEW_COMMANDS.OPEN_AGENT_SETTINGS:
        postSettingsRoute(SETTINGS_TAB.AGENTS, getAgentSettingsSubTab(message));
        break;
      case MAIN_VIEW_COMMANDS.OPEN_MODEL_SETTINGS:
        postSettingsRoute(SETTINGS_TAB.MODELS);
        break;
      case MAIN_VIEW_COMMANDS.OPEN_MULTI_AGENT_SETTINGS:
        postSettingsRoute(SETTINGS_TAB.MULTI_AGENT);
        break;
      case MAIN_VIEW_COMMANDS.OPEN_AGENT_DIRECTORY:
        handleOpenAgentDirectory(message);
        break;
      case MAIN_VIEW_COMMANDS.REQUEST_RECENT_COMMITS:
        bridge.postToRenderer({
          command: MAIN_VIEW_COMMANDS.SET_RECENT_COMMITS,
          commits: [],
          isGitRepo: false,
        });
        break;
      case MAIN_VIEW_COMMANDS.EXECUTE:
        handleExecute(message);
        break;
    }
  }

  const handleNativeThemeUpdate = () => postTheme();

  const bridge = installDesktopHostBridge(window, {
    onRendererMessage: handleRendererMessage,
  });

  nativeTheme.on('updated', handleNativeThemeUpdate);

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    nativeTheme.off('updated', handleNativeThemeUpdate);
    bridge.dispose();
  };
  window.once('closed', dispose);

  return {
    postToRenderer: (message) => bridge.postToRenderer(message),
    dispose,
  };
}
