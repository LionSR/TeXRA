// Local imports - progress view
import { createThemeHandlerFactory } from '@common/themeHandlerFactory.js';
import { COMMON_COMMANDS } from '@common/webview/commands.js';

const link = document.getElementById('hljs-theme');

export const createThemeHandlers = createThemeHandlerFactory(COMMON_COMMANDS, {
  onTheme: (theme) => {
    if (!link) return;
    link.href = `https://cdn.jsdelivr.net/npm/highlight.js@11.11.1/styles/${
      theme === 'dark' ? 'github-dark' : 'github'
    }.css`;
  },
});
