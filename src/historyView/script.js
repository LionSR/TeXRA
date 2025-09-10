// Local imports - history view
import { historyViewDomHandler } from './modules/domHandlers.js';
import { historyViewState } from './modules/historyViewState.js';
import { messageHandler } from './modules/messageHandlers.js';
import { initializeIconButtons } from '@common/iconButtonInitializer.js';
import { HISTORY_VIEW_COMMANDS } from '@common/webview/commands.js';
import { bootstrap } from '@common/webview/bootstrap.js';
import { vscode } from '@common/webviewContext.js';

bootstrap({
  state: [historyViewState],
  messageHandler,
  onDomContentLoaded: () => {
    initializeIconButtons();
    historyViewDomHandler.events.setupEventListeners();
    vscode.postMessage({ command: HISTORY_VIEW_COMMANDS.GET_HISTORY_DATA });
  },
  onBeforeUnload: () => {
    historyViewDomHandler.events.dispose();
    historyViewDomHandler.searchManager.dispose();
  },
});
