// Local imports - memory view
import { memoryViewDomHandler } from './modules/domHandlers.js';
import { memoryViewState } from './modules/memoryViewState.js';
import { messageHandler } from './modules/messageHandlers.js';
// Local imports - common
import { MEMORY_VIEW_COMMANDS } from '@common/webview/commands.js';
import { bootstrapWebview } from '@common/viewBootstrap.js';
import { vscode } from '@common/webviewContext.js';

bootstrapWebview({
  initializeState: () => memoryViewState.initialize(),
  setupHandlers: () => messageHandler.setup(),
  onDomReady: () => {
    memoryViewDomHandler.events.setup();
    vscode.postMessage({ command: MEMORY_VIEW_COMMANDS.GET_MEMORY_DATA });
  },
  onDispose: () => {
    memoryViewDomHandler.dispose();
    messageHandler.dispose();
  },
});
