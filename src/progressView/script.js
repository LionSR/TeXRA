// Local imports - progress view
import { COMMANDS } from './modules/constants.js';
import { progressViewDomHandler } from './modules/domHandlers.js';
import { messageHandler } from './modules/messageHandlers.js';
import { progressViewState } from './modules/progressViewState.js';
import { validateTemplates } from '@common/templateUtils.js';
import { vscode } from '@common/webviewContext.js';

// Initialize the state when the window loads
progressViewState.load();

// Register handlers for VSCode messages
messageHandler.setup();

window.addEventListener('beforeunload', () => {
  messageHandler.cleanup();
});

// Initialize event listeners and state when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  validateTemplates([
    'fileItemTemplate',
    'usageTemplate',
    'bulletTemplate',
    'streamTabTemplate',
    'roundHeaderTemplate',
    'logLineTemplate',
    'nativeStatusTemplate',
    'bannerDetailsTemplate',
    'toolUseTemplate',
    'fileListDetailsTemplate',
    'missingOutputsDetailsTemplate',
    'latexdiffDetailsTemplate',
    'statisticsDetailsTemplate',
    'groupHeaderTemplate',
    'groupDetailsTemplate',
  ]);
  progressViewDomHandler.toolbar.render('workflow');
  progressViewDomHandler.placeholder.show();
  // Setup UI event listeners
  progressViewDomHandler.events.setupEventListeners();
  progressViewDomHandler.followUpInput.setup();
  progressViewDomHandler.approvalRequests.setup();

  // Apply saved group toggle states to any groups already in the DOM
  progressViewDomHandler.events.applyToggleStates();

  // Notify extension that the webview is ready to receive messages
  vscode.postMessage({ command: COMMANDS.WEBVIEW_READY });
});
