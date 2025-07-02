import { vscode } from '@common/webviewContext.js';
import { historyViewDomHandler } from './modules/domHandlers.js';
import { historyViewState } from './modules/historyViewState.js';
import { messageHandlers } from './modules/messageHandlers.js';
import { COMMANDS } from './modules/constants.js';

historyViewState.initialize();

// Register handlers early so messages aren't missed
messageHandlers.setup();

document.addEventListener('DOMContentLoaded', () => {
  historyViewDomHandler.events.setupEventListeners();
  vscode.postMessage({ command: COMMANDS.GET_HISTORY_DATA });
});

window.addEventListener('beforeunload', () => {
  historyViewDomHandler.events.dispose();
  historyViewDomHandler.searchManager.dispose();
  messageHandlers.cleanup();
});
