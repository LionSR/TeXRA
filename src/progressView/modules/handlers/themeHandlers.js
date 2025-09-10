// Local imports - progress view
import { COMMON_COMMANDS } from '@common/webview/commands.js';
import { createThemeHandlers as createCommonThemeHandlers } from '@common/webview/themeHandlers.js';

/**
 * Create handlers for theme and debug mode updates.
 * @param {Object} ctx Context utilities.
 * @param {Function} ctx.postHandle Callback after handling a message.
 */
export function createThemeHandlers({ postHandle } = {}) {
  const link = document.getElementById('hljs-theme');
  const updateHighlightTheme = (theme) => {
    if (!link) return;
    link.href = `https://cdn.jsdelivr.net/npm/highlight.js@11.11.1/styles/${
      theme === 'dark' ? 'github-dark' : 'github'
    }.css`;
  };

  return createCommonThemeHandlers({
    commands: COMMON_COMMANDS,
    postHandle,
    onThemeChange: updateHighlightTheme,
  });
}
