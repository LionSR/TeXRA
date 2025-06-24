import { webviewState } from './modules/webviewState.js';
import { messageHandlers } from './modules/messageHandlers.js';
import {
  setupUIHandlers,
  instructionManager,
  toggleManager,
} from './modules/uiHandlers.js';

// Register handlers immediately so early messages aren't missed
messageHandlers.setup();

window.addEventListener('beforeunload', () => {
  messageHandlers.cleanup();
});

// Setup UI when DOM is loaded
document.addEventListener('DOMContentLoaded', function () {
  webviewState.restore();
  instructionManager.init();
  setupUIHandlers();
  toggleManager.updateToolConfigToggleState();
  toggleManager.updateAutoToggleState();
  toggleManager.setupDocumentListeners();
});
