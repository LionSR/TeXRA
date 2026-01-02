/* global document, window */
// Local imports - profile view
import { profileViewDomHandler } from './modules/domHandlers.js';
import { profileViewState } from './modules/profileViewState.js';
import { messageHandler } from './modules/messageHandlers.js';
import { PROFILE_VIEW_COMMANDS } from '@common/webview/commands.js';
import { vscode } from '@common/webviewContext.js';

profileViewState.initialize();

// Register handlers early so messages aren't missed
messageHandler.setup();

document.addEventListener('DOMContentLoaded', () => {
  profileViewDomHandler.events.setup();
  vscode.postMessage({ command: PROFILE_VIEW_COMMANDS.GET_PROFILE_DATA });
});

window.addEventListener('beforeunload', () => {
  profileViewDomHandler.events.dispose();
  messageHandler.dispose();
});
