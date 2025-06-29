import { webviewState } from './modules/webviewState.js';
import { messageHandlers } from './modules/messageHandlers.js';
import {
  webviewDomHandler,
  instructionManager,
  toggleManager,
} from './modules/domHandlers.js';

// Register handlers immediately so early messages aren't missed
messageHandlers.setup({ requestData: false });

window.addEventListener('beforeunload', () => {
  messageHandlers.cleanup();
  webviewDomHandler.cleanupUI();
});

// Setup UI when DOM is loaded
document.addEventListener('DOMContentLoaded', function () {
  webviewState.restore();
  instructionManager.init();
  webviewDomHandler.initializeUI();
  toggleManager.updateToolConfigToggleState();
  toggleManager.updateAutoToggleState();
  toggleManager.setupDocumentListeners();
  messageHandlers.requestInitialData();
});
