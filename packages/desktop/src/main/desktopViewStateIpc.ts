import { nativeTheme } from 'electron';

import { COMMON_COMMANDS } from '@common/webview/commonCommands';
import { MAIN_VIEW_COMMANDS } from '@common/webview/mainViewCommands';

import type {
  DesktopCommandMessage,
  DesktopMessageHandler,
  DesktopRenderer,
} from './desktopIpcTypes.js';

export type DesktopTheme = 'dark' | 'light' | 'high-contrast';

export interface DesktopViewStateIpcOptions {
  debugMode?: boolean;
  getTheme?: () => DesktopTheme;
}

export interface DesktopViewStateIpc extends DesktopMessageHandler {
  dispose(): void;
}

function getNativeTheme(): DesktopTheme {
  if (nativeTheme.shouldUseHighContrastColors) return 'high-contrast';
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

export function createDesktopViewStateIpc(
  renderer: DesktopRenderer,
  options: DesktopViewStateIpcOptions = {},
): DesktopViewStateIpc {
  const getTheme = options.getTheme ?? getNativeTheme;
  const debugMode = options.debugMode ?? false;

  function postTheme() {
    renderer.postToRenderer({
      command: COMMON_COMMANDS.THEME_SET,
      theme: getTheme(),
    });
  }

  function postDebugMode() {
    renderer.postToRenderer({
      command: COMMON_COMMANDS.DEBUG_MODE_SET,
      debugMode,
    });
  }

  function postInitialState() {
    postTheme();
    postDebugMode();
  }

  const handleNativeThemeUpdate = () => postTheme();
  nativeTheme.on('updated', handleNativeThemeUpdate);

  return {
    handleMessage(message: DesktopCommandMessage): boolean {
      switch (message.command) {
        case MAIN_VIEW_COMMANDS.WEBVIEW_READY:
          postInitialState();
          return true;
        case MAIN_VIEW_COMMANDS.GET_THEME:
          postTheme();
          return true;
        case MAIN_VIEW_COMMANDS.GET_DEBUG_MODE:
          postDebugMode();
          return true;
        default:
          return false;
      }
    },
    dispose() {
      nativeTheme.off('updated', handleNativeThemeUpdate);
    },
  };
}
