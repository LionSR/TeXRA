import { vscode } from './modules/vscodeApi.js';
import { restoreState } from './modules/stateManager.js';
import { setupMessageHandlers } from './modules/messageHandlers.js';
import { setupUIHandlers } from './modules/uiHandlers.js';

window.onload = function () {
  const dataRequests = [
    'getTheme',
    'requestInputFile',
    'requestReferenceFile',
    'requestAuxiliaryFile',
    'requestFigureFile',
    'requestRecentCommits',
    'requestBaseFile',
  ];

  dataRequests.forEach((request) => {
    vscode.postMessage({ command: request });
  });

  // Set default state for new folders
  restoreState();
};

setupMessageHandlers();

document.addEventListener('DOMContentLoaded', function () {
  setupUIHandlers();
});
