// Local imports - memory view
import { memoryViewDomHandler } from './modules/domHandlers.js';
import { memoryViewState } from './modules/memoryViewState.js';
import { messageHandler } from './modules/messageHandlers.js';
import { MEMORY_VIEW_COMMANDS } from '@common/webview/commands.js';
import { vscode } from '@common/webviewContext.js';

memoryViewState.initialize();

// Register handlers early so messages aren't missed
messageHandler.setup();

document.addEventListener('DOMContentLoaded', () => {
  memoryViewDomHandler.events.setup();
  vscode.postMessage({ command: MEMORY_VIEW_COMMANDS.GET_MEMORY_DATA });
});

window.addEventListener('beforeunload', () => {
  memoryViewDomHandler.events.dispose();
  messageHandler.dispose();
});
