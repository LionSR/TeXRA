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

let fileInputManager;
let actionButtonManager;
let settingsButtonManager;

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

  fileInputManager = new FileInputManager(
    vscode,
    webviewState,
    fileList,
    fileSelect,
    outputFilesManager,
  );
  actionButtonManager = new ActionButtonManager(
    vscode,
    fileList,
    webviewState,
    instructionManager,
  );
  settingsButtonManager = new SettingsButtonManager(
    vscode,
    toggleManager,
    latexdiffManager,
    webviewState,
  );

  fileInputManager.setup();
  actionButtonManager.setup();
  settingsButtonManager.setup();
  recordingManager.setupRecordButton();
}

export function cleanupUI() {
  if (fileInputManager) {
    fileInputManager.cleanup();
    fileInputManager = undefined;
  }
  if (actionButtonManager) {
    actionButtonManager.cleanup();
    actionButtonManager = undefined;
  }
  if (settingsButtonManager) {
    settingsButtonManager.cleanup();
    settingsButtonManager = undefined;
  }
}
