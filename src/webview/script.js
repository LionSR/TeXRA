// Local imports - webview
import {
  mainViewDomHandler,
  instructionManager,
  disposeManagers,
} from './modules/domHandlers.js';
import { mainViewState } from './modules/mainViewState.js';
import {
  setup as setupHandlers,
  dispose as disposeHandlers,
} from './modules/messageHandlers.js';
// Local imports - common
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands.js';
import { bootstrapWebview } from '@common/viewBootstrap.js';
import { vscode } from '@common/webviewContext.js';

bootstrapWebview({
  initializeState: () => mainViewState.initialize(),
  setupHandlers: () => setupHandlers({ requestData: false }),
  onDomReady: () => {
    instructionManager.setup();
    mainViewDomHandler.initializeUI();
    setupHandlers({ requestData: true });
    vscode.postMessage({ command: MAIN_VIEW_COMMANDS.WEBVIEW_READY });
  },
  onDispose: () => {
    disposeHandlers();
    disposeManagers();
  },
});
