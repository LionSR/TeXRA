/**
 * Common commands used across all webviews.
 */

// Common commands used across all views
export const COMMON_COMMANDS = {
  THEME_SET: 'setTheme',
  DEBUG_MODE_SET: 'setDebugMode',
  STATE_RESTORE: 'restoreState',
  WEBVIEW_READY: 'webviewReady',
  ERROR: 'error',
  SWITCH_VIEW: 'switchView',
} as const;
