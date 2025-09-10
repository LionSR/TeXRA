// Local imports - webview
import {
  mainViewDomHandler,
  instructionManager,
  toggleManager,
} from './modules/domHandlers.js';
import { mainViewState } from './modules/mainViewState.js';
import {
  setup as setupHandlers,
  cleanup as cleanupHandlers,
} from './modules/messageHandlers.js';
import { initializeIconButtons } from '@common/iconButtonInitializer.js';
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands.js';
import { bootstrap } from '@common/webview/bootstrap.js';
import { vscode } from '@common/webviewContext.js';

bootstrap({
  state: [mainViewState],
  messageHandler: {
    setup: () => setupHandlers({ requestData: false }),
    cleanup: cleanupHandlers,
  },
  onDomContentLoaded: () => {
    initializeIconButtons();
    instructionManager.setup();
    mainViewDomHandler.initializeUI();
    toggleManager.updateToolConfigToggleState();
    toggleManager.updateAutoToggleState();
    toggleManager.setupDocumentListeners();
    setupHandlers({ requestData: true });
    vscode.postMessage({ command: MAIN_VIEW_COMMANDS.WEBVIEW_READY });
  },
  onBeforeUnload: () => {
    mainViewDomHandler.cleanupUI();
  },
});
