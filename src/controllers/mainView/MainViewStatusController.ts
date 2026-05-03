// Local imports - common
import { MAIN_VIEW_COMMANDS } from '@common/webview/mainViewCommands';

export interface MainViewAuthStatus {
  authenticated: boolean;
}

type MainViewStatusMessage =
  | { command: typeof MAIN_VIEW_COMMANDS.THEME_SET; theme: 'dark' | 'light' }
  | { command: typeof MAIN_VIEW_COMMANDS.DEBUG_MODE_SET; debugMode: boolean }
  | { command: typeof MAIN_VIEW_COMMANDS.HIDE_LOGIN_BANNER };

export class MainViewStatusController {
  getThemeMessage(isDarkTheme: boolean): MainViewStatusMessage {
    return {
      command: MAIN_VIEW_COMMANDS.THEME_SET,
      theme: isDarkTheme ? 'dark' : 'light',
    };
  }

  getDebugModeMessage(debugMode: boolean): MainViewStatusMessage {
    return {
      command: MAIN_VIEW_COMMANDS.DEBUG_MODE_SET,
      debugMode,
    };
  }

  getPostSignInMessage(
    authStatus: MainViewAuthStatus,
  ): MainViewStatusMessage | null {
    if (!authStatus.authenticated) return null;
    return {
      command: MAIN_VIEW_COMMANDS.HIDE_LOGIN_BANNER,
    };
  }
}
