import { webviewState } from './modules/webviewState.js';
import { messageHandlers } from './modules/messageHandlers.js';
import {
  initializeUI,
  cleanupUI,
  instructionManager,
  toggleManager,
} from './modules/uiHandlers.js';

// Register handlers immediately so early messages aren't missed
messageHandlers.setup({ requestData: false });

window.addEventListener('beforeunload', () => {
  messageHandlers.cleanup();
  cleanupUI();
});

// Setup UI when DOM is loaded
document.addEventListener('DOMContentLoaded', function () {
  webviewState.restore();
  instructionManager.init();
  initializeUI();
  toggleManager.updateToolConfigToggleState();
  toggleManager.updateAutoToggleState();
  toggleManager.setupDocumentListeners();
  messageHandlers.requestInitialData();
});
