import { nativeTheme, type BrowserWindow } from 'electron';

import { COMMON_COMMANDS } from '@common/webview/commonCommands';
import { MAIN_VIEW_COMMANDS } from '@common/webview/mainViewCommands';

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
