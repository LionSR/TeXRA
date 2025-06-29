import { vscode } from '@common/webviewContext.js';
import { historyViewDomHandler } from './modules/domHandlers.js';
import { historyViewState } from './modules/historyViewState.js';
import { messageHandlers } from './modules/messageHandlers.js';

historyViewState.initialize();

// Register handlers early so messages aren't missed
messageHandlers.setup();

document.addEventListener('DOMContentLoaded', () => {
  historyViewDomHandler.events.setupEventListeners();
  vscode.postMessage({ command: 'getHistoryData' });
});

window.addEventListener('beforeunload', () => {
  historyViewDomHandler.events.dispose();
  historyViewDomHandler.searchManager.dispose();
  messageHandlers.cleanup();
});
