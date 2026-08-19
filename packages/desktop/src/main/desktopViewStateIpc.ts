import { nativeTheme } from 'electron';

import { COMMON_COMMANDS, MAIN_VIEW_COMMANDS } from '@shared/ipc';
import { DESKTOP_THEME_KIND, type DesktopThemeKind } from '@shared/schemas';

import {
  createCommandHandler,
  type DesktopMessageHandler,
  type DesktopRenderer,
} from './desktopIpcTypes.js';

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
): DesktopViewStateIpc {
  function postTheme() {
    renderer.postToRenderer({
      command: COMMON_COMMANDS.THEME_SET,
      theme: getNativeTheme(),
    });
  }

  function postDebugMode() {
    renderer.postToRenderer({
      command: COMMON_COMMANDS.DEBUG_MODE_SET,
      debugMode: false,
    });
  }

  nativeTheme.on('updated', postTheme);

  const handler = createCommandHandler({
    // WEBVIEW_READY is a broadcast: sync theme/debug-mode only for the main
    // webview, but return `false` so sibling handlers still receive it.
    [MAIN_VIEW_COMMANDS.WEBVIEW_READY]: {
      when: (message) => message.view === 'main',
      run: () => {
        postTheme();
        postDebugMode();
      },
      claim: false,
    },
    [MAIN_VIEW_COMMANDS.GET_THEME]: () => postTheme(),
    [MAIN_VIEW_COMMANDS.GET_DEBUG_MODE]: () => postDebugMode(),
  });

  return {
    handleMessage: handler.handleMessage,
    dispose() {
      nativeTheme.off('updated', postTheme);
    },
  };
}
