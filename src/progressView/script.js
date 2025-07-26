import { progressViewState } from './modules/progressViewState.js';
import { messageHandler } from './modules/messageHandlers.js';
import { progressViewDomHandler } from './modules/domHandlers.js';
import { vscode } from '@common/webviewContext.js';
import { COMMANDS } from './modules/constants.js';
import { validateTemplates } from '@common/templateUtils.js';
import { initializeIconButtons } from '@common/iconButtonInitializer.js';

// Initialize the state when the window loads
progressViewState.initialize();

// Register handlers for VSCode messages
messageHandler.setup();

window.addEventListener('beforeunload', () => {
  messageHandler.cleanup();
});

// Initialize event listeners and state when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  validateTemplates([
    'fileItemTemplate',
    'iconButtonTemplate',
    'usageTemplate',
    'bulletTemplate',
    'streamTabTemplate',
    'roundHeaderTemplate',
  ]);
  initializeIconButtons();
  progressViewDomHandler.toolbar.render();
  // Setup UI event listeners
  progressViewDomHandler.events.setupEventListeners();

  // Apply saved group toggle states to any groups already in the DOM
  progressViewDomHandler.events.applyToggleStates();

  // Notify extension that the webview is ready to receive messages
  vscode.postMessage({ command: COMMANDS.WEBVIEW_READY });
});
