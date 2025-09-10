// Factory creator for theme-related message handlers
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
