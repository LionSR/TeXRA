export interface ThemeHandlerParams {
  commands?: { THEME_SET: string; DEBUG_MODE_SET: string };
  postHandle?: () => void;
  onThemeChange?: (theme: string) => void;
  onDebugModeChange?: (debugMode: boolean) => void;
}

/**
 * Create handlers for theme and debug mode updates.
 */
export function createThemeHandlers(
  params: ThemeHandlerParams = {},
): Record<string, (message: unknown) => void> {
  const { commands, postHandle, onThemeChange, onDebugModeChange } = params;

  if (!commands) {
    return {};
  }

  return {
    [commands.THEME_SET]: (message: any) => {
      if (!message || typeof message.theme !== 'string') {
        console.warn('Invalid theme message:', message);
        return;
      }
      document.body.className = message.theme;
      onThemeChange?.(message.theme);
      postHandle?.();
    },
    [commands.DEBUG_MODE_SET]: (message: any) => {
      onDebugModeChange?.(Boolean(message?.debugMode));
      postHandle?.();
    },
  };
}
