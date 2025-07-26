import { mainViewState } from './modules/mainViewState.js';
import { messageHandler } from './modules/messageHandlers.js';
import {
  mainViewDomHandler,
  instructionManager,
  toggleManager,
} from './modules/domHandlers.js';
import { initializeIconButtons } from '@common/iconButtonInitializer.js';

// Register handlers immediately so early messages aren't missed
messageHandler.setup({ requestData: false });

window.addEventListener('beforeunload', () => {
  messageHandler.cleanup();
  mainViewDomHandler.cleanupUI();
});

// Setup UI when DOM is loaded
document.addEventListener('DOMContentLoaded', function () {
  initializeIconButtons();
  mainViewState.restore();
  instructionManager.setup();
  mainViewDomHandler.initializeUI();
  toggleManager.updateToolConfigToggleState();
  toggleManager.updateAutoToggleState();
  toggleManager.setupDocumentListeners();
  messageHandler.requestInitialData();
});
