/**
 * @typedef {Object} ThemeHandlerFactoryOptions
 * @property {(theme: string, message: any) => void} [onTheme] - Callback when theme is set
 * @property {(message: any) => void} [onDebug] - Callback when debug mode is updated
 * @property {Record<string, (message: any) => void>} [extraHandlers] - Additional handlers keyed by command name
 */

/**
 * @typedef {Object} ThemeHandlerContext
 * @property {() => void} [postHandle] - Callback executed after every handler
 */

/**
 * Factory creator for theme-related message handlers.
 * @param {Record<string, string>} commands - Command constants containing THEME_SET and DEBUG_MODE_SET
 * @param {ThemeHandlerFactoryOptions} [options={}] - Optional callbacks for view-specific behavior
 * @returns {(context?: ThemeHandlerContext) => Record<string, (message: any) => void>} Factory function that creates theme handlers
 */
export function createThemeHandlerFactory(
  commands,
  { onTheme, onDebug, extraHandlers = {} } = {},
) {
  return function createThemeHandlers({ postHandle } = {}) {
    const handlers = {
      [commands.THEME_SET]: (message) => {
        if (!message || typeof message.theme !== 'string') {
          console.warn('Invalid theme message:', message);
          return;
        }
        document.body.className = message.theme;
        if (onTheme) onTheme(message.theme, message);
        if (postHandle) postHandle();
      },
      [commands.DEBUG_MODE_SET]: (message) => {
        if (onDebug) onDebug(message);
        if (postHandle) postHandle();
      },
    };

    for (const [command, handler] of Object.entries(extraHandlers)) {
      handlers[command] = (message) => {
        handler(message);
        if (postHandle) postHandle();
      };
    }

    return handlers;
  };
}
