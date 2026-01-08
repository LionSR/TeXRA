// Local imports - profile view
import { profileViewDomHandler } from './modules/domHandlers.js';
import { profileViewState } from './modules/profileViewState.js';
import { messageHandler } from './modules/messageHandlers.js';
// Local imports - common
import { PROFILE_VIEW_COMMANDS } from '@common/webview/commands.js';
import { bootstrapWebview } from '@common/viewBootstrap.js';
import { vscode } from '@common/webviewContext.js';

bootstrapWebview({
  initializeState: () => profileViewState.initialize(),
  setupHandlers: () => messageHandler.setup(),
  onDomReady: () => {
    profileViewDomHandler.events.setup();
    vscode.postMessage({ command: PROFILE_VIEW_COMMANDS.GET_PROFILE_DATA });
  },
  onDispose: () => {
    profileViewDomHandler.dispose();
    messageHandler.dispose();
  },
});
