import { nativeTheme, type BrowserWindow } from 'electron';

import { COMMON_COMMANDS } from '@common/webview/commonCommands';
import { MAIN_VIEW_COMMANDS } from '@common/webview/mainViewCommands';

import {
  DESKTOP_SHELL_COMMANDS,
  type DesktopRoute,
} from '../desktopShellMessages.js';
import {
  installDesktopHostBridge,
  type DesktopHostBridge,
} from './hostBridge.js';

type DesktopTheme = 'dark' | 'light' | 'high-contrast';

export interface DesktopMainViewIpcOptions {
  debugMode?: boolean;
  getTheme?: () => DesktopTheme;
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
  function postRouteForSwitchView(message: unknown) {
    const view =
      typeof message === 'object' && message !== null && 'view' in message
        ? message.view
        : undefined;
    const route =
      view === 'progress' ? 'progress' : view === 'main' ? 'main' : 'settings';
    postRoute(route);
  }
  function postInitialState() {
    postTheme();
    postDebugMode();
  }
  function handleRendererMessage(message: unknown) {
    if (!isMessageWithCommand(message)) return;

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
      case MAIN_VIEW_COMMANDS.OPEN_AGENT_SETTINGS:
      case MAIN_VIEW_COMMANDS.OPEN_MODEL_SETTINGS:
      case MAIN_VIEW_COMMANDS.OPEN_MULTI_AGENT_SETTINGS:
        postRoute('settings');
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
