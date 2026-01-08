// Local imports - history view
import { historyViewDomHandler } from './modules/domHandlers.js';
import { historyViewState } from './modules/historyViewState.js';
import { messageHandler } from './modules/messageHandlers.js';
// Local imports - common
import { HISTORY_VIEW_COMMANDS } from '@common/webview/commands.js';
import { bootstrapWebview } from '@common/viewBootstrap.js';
import { vscode } from '@common/webviewContext.js';

bootstrapWebview({
  initializeState: () => historyViewState.initialize(),
  setupHandlers: () => messageHandler.setup(),
  onDomReady: () => {
    historyViewDomHandler.events.setup();
    vscode.postMessage({ command: HISTORY_VIEW_COMMANDS.GET_HISTORY_DATA });
  },
  onDispose: () => {
    historyViewDomHandler.dispose();
    messageHandler.dispose();
  },
});
