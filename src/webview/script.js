import { mainViewState } from './modules/mainViewState.js';
import {
  setup as setupHandlers,
  cleanup as cleanupHandlers,
} from './modules/messageHandlers.js';
import {
  mainViewDomHandler,
  instructionManager,
  toggleManager,
} from './modules/domHandlers.js';

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
  toggleManager.updateToolConfigToggleState();
  toggleManager.updateAutoToggleState();
  toggleManager.setupDocumentListeners();
  setupHandlers({ requestData: true });
});
