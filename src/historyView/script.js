// Local imports - history view
import { historyViewDomHandler } from './modules/domHandlers.js';
import { historyViewState } from './modules/historyViewState.js';
import { messageHandler } from './modules/messageHandlers.js';
import { HISTORY_VIEW_COMMANDS } from '@common/webview/commands.js';
import { vscode } from '@common/webviewContext.js';

historyViewState.initialize();

// Register handlers early so messages aren't missed
messageHandler.setup();

document.addEventListener('DOMContentLoaded', () => {
  historyViewDomHandler.events.setupEventListeners();
  vscode.postMessage({ command: HISTORY_VIEW_COMMANDS.GET_HISTORY_DATA });
});

window.addEventListener('beforeunload', () => {
  historyViewDomHandler.events.dispose();
  historyViewDomHandler.searchManager.dispose();
  messageHandler.cleanup();
});
