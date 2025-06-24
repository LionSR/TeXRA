import { webviewState } from './modules/webviewState.js';
import { vscode } from '@common/webviewContext.js';
import {
  setupMessageHandlers,
  initializeDataRequests,
} from './modules/messageHandlers.js';
import {
  setupUIHandlers,
  instructionManager,
  toggleManager,
} from './modules/uiHandlers.js';

// Initialize data requests when window loads
window.onload = function () {
  initializeDataRequests();

  // Set default state for new folders
  webviewState.restore();

  instructionManager.init();
};

// Setup message handlers
setupMessageHandlers();

// Setup UI when DOM is loaded
document.addEventListener('DOMContentLoaded', function () {
  setupUIHandlers();
  toggleManager.updateToolConfigToggleState();
  toggleManager.updateAutoToggleState();
  toggleManager.setupDocumentListeners();
});
