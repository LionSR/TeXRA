// Local imports - webview
import { mainViewDomHandler } from '../domHandlers.js';
// Local imports - DOM utilities
import { safeSetElementValue } from '@common/domUtils.js';
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands.js';
import { createThemeHandlers as createCommonThemeHandlers } from '@common/webview/themeHandlers.js';

/**
 * Create handlers related to theme and model configuration.
 * @param {Object} ctx Context with helper functions.
 * @param {Function} ctx.postHandle Function to call after handling a message.
 */
export function createThemeHandlers({ postHandle }) {
  const baseHandlers = createCommonThemeHandlers({
    commands: MAIN_VIEW_COMMANDS,
    postHandle,
    onDebugModeChange: (debugMode) =>
      mainViewDomHandler.setDebugMode(debugMode),
  });

  return {
    ...baseHandlers,
    [MAIN_VIEW_COMMANDS.MODEL_SELECTED]: (message) => {
      safeSetElementValue('model', message.model);
      postHandle();
    },
  };
}
