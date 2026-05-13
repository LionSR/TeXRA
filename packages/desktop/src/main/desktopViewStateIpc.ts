import { nativeTheme } from 'electron';

import { COMMON_COMMANDS } from '@common/webview/commonCommands';
import { MAIN_VIEW_COMMANDS } from '@common/webview/mainViewCommands';
import {
  DESKTOP_THEME_KIND,
  type DesktopThemeKind,
} from '@shared/constants/desktopTheme';

import type {
  DesktopCommandMessage,
  DesktopMessageHandler,
  DesktopRenderer,
} from './desktopIpcTypes.js';

export type DesktopTheme = DesktopThemeKind;

export interface DesktopViewStateIpcOptions {
  debugMode?: boolean;
  getTheme?: () => DesktopThemeKind;
}

export interface DesktopViewStateIpc extends DesktopMessageHandler {
  dispose(): void;
}

function getNativeTheme(): DesktopThemeKind {
  if (nativeTheme.shouldUseHighContrastColors) {
    return DESKTOP_THEME_KIND.HIGH_CONTRAST;
  }
  return nativeTheme.shouldUseDarkColors
    ? DESKTOP_THEME_KIND.DARK
    : DESKTOP_THEME_KIND.LIGHT;
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

  nativeTheme.on('updated', postTheme);

  return {
    handleMessage(message: DesktopCommandMessage): boolean {
      switch (message.command) {
        case MAIN_VIEW_COMMANDS.WEBVIEW_READY:
          postTheme();
          postDebugMode();
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
      nativeTheme.off('updated', postTheme);
    },
  };
}
