// Local imports - progress view
import { COMMANDS } from './modules/constants.js';
import { progressViewDomHandler } from './modules/domHandlers.js';
import { messageHandler } from './modules/messageHandlers.js';
import { progressViewState } from './modules/progressViewState.js';
// Local imports - common
import { bootstrapWebview } from '@common/viewBootstrap.js';
import { vscode } from '@common/webviewContext.js';

bootstrapWebview({
  initializeState: () => progressViewState.initialize(),
  setupHandlers: () => messageHandler.setup(),
  onDomReady: () => {
    progressViewDomHandler.initializeUI();
    vscode.postMessage({ command: COMMANDS.WEBVIEW_READY });
  },
  onDispose: () => {
    messageHandler.dispose();
    progressViewDomHandler.disposeUI();
  },
});
