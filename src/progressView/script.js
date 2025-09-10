// Local imports - progress view
import { COMMANDS } from './modules/constants.js';
import { progressViewDomHandler } from './modules/domHandlers.js';
import { messageHandler } from './modules/messageHandlers.js';
import { progressViewState } from './modules/progressViewState.js';
import { initializeIconButtons } from '@common/iconButtonInitializer.js';
import { validateTemplates } from '@common/templateUtils.js';
import { bootstrap } from '@common/webview/bootstrap.js';
import { vscode } from '@common/webviewContext.js';

bootstrap({
  state: [progressViewState],
  messageHandler,
  onDomContentLoaded: () => {
    validateTemplates([
      'fileItemTemplate',
      'iconButtonTemplate',
      'usageTemplate',
      'bulletTemplate',
      'streamTabTemplate',
      'roundHeaderTemplate',
      'logLineTemplate',
      'specialDetailsTemplate',
      'toolUseTemplate',
      'modelResponseTemplate',
      'fileListDetailsTemplate',
      'missingOutputsDetailsTemplate',
      'latexdiffDetailsTemplate',
      'statisticsDetailsTemplate',
      'groupHeaderTemplate',
    ]);
    initializeIconButtons();
    progressViewDomHandler.toolbar.render();
    progressViewDomHandler.placeholder.show();
    progressViewDomHandler.events.setupEventListeners();
    progressViewDomHandler.events.applyToggleStates();
    vscode.postMessage({ command: COMMANDS.WEBVIEW_READY });
  },
});
