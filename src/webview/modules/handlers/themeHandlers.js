// Local imports - webview
import { mainViewDomHandler } from '../domHandlers.js';
import { safeSetElementValue } from '@common/domUtils.js';
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands.js';
import { createThemeHandlerFactory } from '@common/themeHandlerFactory.js';

export const createThemeHandlers = createThemeHandlerFactory(
  MAIN_VIEW_COMMANDS,
  {
    onDebug: (message) => {
      mainViewDomHandler.setDebugMode(message.debugMode);
    },
    extraHandlers: {
      [MAIN_VIEW_COMMANDS.MODEL_SELECTED]: (message) => {
        safeSetElementValue('model', message.model);
      },
    },
  },
);
