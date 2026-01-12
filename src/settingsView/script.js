/**
 * Settings View Entry Point
 */
import { settingsViewDomHandler } from './modules/domHandlers.js';
import { settingsViewState } from './modules/settingsViewState.js';
import { messageHandler } from './modules/messageHandlers.js';
import { SETTINGS_VIEW_COMMANDS } from './modules/constants.js';
import { vscode } from '@common/webviewContext.js';

// Initialize state from persisted storage
settingsViewState.initialize();

// Register message handlers EARLY (before DOM load)
messageHandler.setup();

// On DOM ready, initialize DOM handlers and request data
document.addEventListener('DOMContentLoaded', () => {
  // Initialize all DOM handlers
  settingsViewDomHandler.initialize();

  // Request initial data from extension
  vscode.postMessage({
    command: SETTINGS_VIEW_COMMANDS.GET_INITIAL_DATA,
  });
});

// Cleanup on unload
window.addEventListener('beforeunload', () => {
  settingsViewDomHandler.dispose();
  messageHandler.dispose();
});
