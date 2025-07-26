// Local imports - DOM utilities
import { safeSetElementValue } from '@common/domUtils.js';
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands.js';
import { mainViewDomHandler } from '../domHandlers.js';

/**
 * Create handlers related to theme and model configuration.
 * @param {Object} ctx Context with helper functions.
 * @param {Function} ctx.postHandle Function to call after handling a message.
 */
export function createThemeHandlers({ postHandle }) {
  return {
    [MAIN_VIEW_COMMANDS.THEME_SET]: (message) => {
      if (!message || typeof message.theme !== 'string') {
        console.warn('Invalid theme message:', message);
        return;
      }
      document.body.className = message.theme;
      postHandle();
    },
    [MAIN_VIEW_COMMANDS.DEBUG_MODE_SET]: (message) => {
      mainViewDomHandler.setDebugMode(message.debugMode);
      postHandle();
    },
    [MAIN_VIEW_COMMANDS.MODEL_SELECTED]: (message) => {
      safeSetElementValue('model', message.model);
      postHandle();
    },
  };
}
