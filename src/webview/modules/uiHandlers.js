import { vscode } from '@common/webviewContext.js';
import { webviewState } from './webviewState.js';
import { fileList } from './uiManagers/FileList.js';
import { fileSelect } from './uiManagers/FileSelect.js';
import { outputFilesManager } from './uiManagers/OutputFilesManager.js';
import { latexdiffManager } from './uiManagers/LatexdiffManager.js';
import { InstructionManager } from './uiManagers/InstructionManager.js';
import { ToggleManager } from './uiManagers/ToggleManager.js';
import { RecordingManager } from './uiManagers/RecordingManager.js';
import { FileInputManager } from './uiManagers/FileInputManager.js';
import { ActionButtonManager } from './uiManagers/ActionButtonManager.js';
import { SettingsButtonManager } from './uiManagers/SettingsButtonManager.js';
import { webviewEventBus } from './eventBus.js';

export const instructionManager = new InstructionManager(
  'instruction',
  vscode,
  webviewState,
);
export const toggleManager = new ToggleManager();
export const recordingManager = new RecordingManager(vscode, webviewEventBus);

let debugMode = false;

function updateDebugButtonVisibility() {
  const packBtn = document.getElementById('packButton');
  const cleanBtn = document.getElementById('cleanButton');
  [packBtn, cleanBtn].forEach((btn) => {
    if (btn) {
      btn.style.display = debugMode ? '' : 'none';
    }
  });
}

export function setDebugMode(enabled) {
  debugMode = !!enabled;
  updateDebugButtonVisibility();
}

export function initializeUI() {
  updateDebugButtonVisibility();

  const fileInputManager = new FileInputManager(
    vscode,
    webviewState,
    fileList,
    fileSelect,
    outputFilesManager,
  );
  const actionButtonManager = new ActionButtonManager(
    vscode,
    fileList,
    webviewState,
    instructionManager,
  );
  const settingsButtonManager = new SettingsButtonManager(
    vscode,
    toggleManager,
    latexdiffManager,
  );

  fileInputManager.setup();
  actionButtonManager.setup();
  settingsButtonManager.setup();
  recordingManager.setupRecordButton();
}
