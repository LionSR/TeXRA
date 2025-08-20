// Local imports - progress view
// Handler for theme-related messages in the progress view
import { COMMON_COMMANDS } from '@common/webview/commands.js';

/**
 * Create handlers for theme and debug mode updates.
 * @param {Object} ctx Context utilities.
 * @param {Function} ctx.postHandle Callback after handling a message.
 */
export function createThemeHandlers({ postHandle } = {}) {
  const link = document.getElementById('hljs-theme');
  const updateHighlightTheme = (theme) => {
    if (!link) return;
    link.href = `https://cdn.jsdelivr.net/npm/highlight.js@11.11.1/styles/${theme === 'dark' ? 'github-dark' : 'github'}.css`;
  };

  return {
    [COMMON_COMMANDS.THEME_SET]: (message) => {
      if (!message || typeof message.theme !== 'string') {
        console.warn('Invalid theme message:', message);
        return;
      }
      document.body.className = message.theme;
      updateHighlightTheme(message.theme);
      if (postHandle) postHandle();
    },
    [COMMON_COMMANDS.DEBUG_MODE_SET]: (message) => {
      if (postHandle) postHandle();
    },
  };
}
