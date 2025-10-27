// Local imports - webview
import {
  mainViewDomHandler,
  instructionManager,
} from './modules/domHandlers.js';
import { mainViewState } from './modules/mainViewState.js';
import {
  setup as setupHandlers,
  cleanup as cleanupHandlers,
} from './modules/messageHandlers.js';
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands.js';
import { vscode } from '@common/webviewContext.js';

// Register handlers immediately so early messages aren't missed
setupHandlers({ requestData: false });

window.addEventListener('beforeunload', () => {
  cleanupHandlers();
  mainViewDomHandler.cleanupUI();
});

// Setup UI when DOM is loaded
document.addEventListener('DOMContentLoaded', function () {
  mainViewState.restore();
  instructionManager.setup();
  mainViewDomHandler.initializeUI();
  setupHandlers({ requestData: true });
  vscode.postMessage({ command: MAIN_VIEW_COMMANDS.WEBVIEW_READY });
});
