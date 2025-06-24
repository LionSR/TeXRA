import { vscode, registerMessageHandlers } from '@common/webviewContext.js';
import { historyViewDomHandler } from './modules/domHandlers.js';
import { historyViewState } from './modules/historyViewState.js';

historyViewState.initialize();

document.addEventListener('DOMContentLoaded', () => {
  historyViewDomHandler.events.setupEventListeners();
  vscode.postMessage({ command: 'getHistoryData' });
});

registerMessageHandlers({
  updateHistory: (message) => {
    historyViewDomHandler.renderer.render(message.historyItems);
  },
  historyCleared: () => {
    historyViewDomHandler.renderer.render([]);
  },
});
