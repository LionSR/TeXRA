import { mainViewState } from './modules/mainViewState.js';
import { mainViewMessageHandler } from './modules/messageHandlers.js';
import {
  mainViewDomHandler,
  instructionManager,
  toggleManager,
} from './modules/domHandlers.js';

// Register handlers immediately so early messages aren't missed
mainViewMessageHandler.setup({ requestData: false });

window.addEventListener('beforeunload', () => {
  mainViewMessageHandler.cleanup();
  mainViewDomHandler.cleanupUI();
});

// Setup UI when DOM is loaded
document.addEventListener('DOMContentLoaded', function () {
  mainViewState.restore();
  instructionManager.setup();
  mainViewDomHandler.initializeUI();
  toggleManager.updateToolConfigToggleState();
  toggleManager.updateAutoToggleState();
  toggleManager.setupDocumentListeners();
  mainViewMessageHandler.requestInitialData();
});
