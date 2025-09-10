/**
 * Factory creator for theme and debug mode message handlers.
 * Allows optional view-specific callbacks and extra commands.
 */
export interface ThemeHandlerFactoryOptions {
  /** Callback when theme is set. Receives the theme string and full message. */
  onTheme?: (theme: string, message: any) => void;
  /** Callback when debug mode flag is updated. */
  onDebug?: (message: any) => void;
  /** Additional handlers keyed by command name. */
  extraHandlers?: Record<string, (message: any) => void>;
}

export interface ThemeHandlerContext {
  /** Callback executed after every handler. */
  postHandle?: () => void;
}

/**
 * Create a factory for theme handlers scoped to specific command constants.
 * @param commands Command constants containing THEME_SET and DEBUG_MODE_SET.
 * @param options Optional callbacks for view-specific behavior.
 */
export function createThemeHandlerFactory(
  commands: Record<string, string>,
  options: ThemeHandlerFactoryOptions = {},
) {
  const { onTheme, onDebug, extraHandlers = {} } = options;

  return function createThemeHandlers({
    postHandle,
  }: ThemeHandlerContext = {}) {
    const handlers: Record<string, (message: any) => void> = {
      [commands.THEME_SET]: (message: any) => {
        if (!message || typeof message.theme !== 'string') {
          console.warn('Invalid theme message:', message);
          return;
        }
        document.body.className = message.theme;
        onTheme?.(message.theme, message);
        postHandle?.();
      },
      [commands.DEBUG_MODE_SET]: (message: any) => {
        onDebug?.(message);
        postHandle?.();
      },
    };

    for (const [command, handler] of Object.entries(extraHandlers)) {
      handlers[command] = (message: any) => {
        handler(message);
        postHandle?.();
      };
    }

    return handlers;
  };
}
