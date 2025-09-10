// Local imports - webview
// (none)

/**
 * Create handlers for theme and debug mode updates.
 * @param {Object} params
 * @param {Object} params.commands Command constants providing THEME_SET and DEBUG_MODE_SET.
 * @param {Function} [params.postHandle] Callback after handling a message.
 * @param {(theme: string) => void} [params.onThemeChange] Optional theme change callback.
 * @param {(debugMode: boolean) => void} [params.onDebugModeChange] Optional debug mode callback.
 * @returns {Object} Message handlers keyed by command.
 */
export function createThemeHandlers({
  commands,
  postHandle,
  onThemeChange,
  onDebugModeChange,
} = {}) {
  return {
    [commands.THEME_SET]: (message) => {
      if (!message || typeof message.theme !== 'string') {
        console.warn('Invalid theme message:', message);
        return;
      }
      document.body.className = message.theme;
      if (onThemeChange) onThemeChange(message.theme);
      if (postHandle) postHandle();
    },
    [commands.DEBUG_MODE_SET]: (message) => {
      if (onDebugModeChange) onDebugModeChange(message.debugMode);
      if (postHandle) postHandle();
    },
  };
}
