import { vscode } from '@common/webviewContext.js';
import { webviewState } from './webviewState.js';
import { ELEMENTS_TO_SAVE } from './constants.js';
import {
  addEventListenerSafely,
  safeGetElementById,
} from '@common/domUtils.js';
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
  const packBtn = safeGetElementById('packButton');
  const cleanBtn = safeGetElementById('cleanButton');
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

  const fileInputManager = new FileInputManager(vscode, webviewState);
  const actionButtonManager = new ActionButtonManager(vscode);
  const settingsButtonManager = new SettingsButtonManager(
    toggleManager,
    vscode,
    webviewState,
  );

  fileInputManager.setup();
  settingsButtonManager.setup();
  actionButtonManager.setup();
  recordingManager.setupRecordButton();

  ELEMENTS_TO_SAVE.forEach((id) => {
    if (id !== 'instruction') {
      addEventListenerSafely(id, 'change', () => webviewState.save());
    }
  });
  addEventListenerSafely('instruction', 'input', () => webviewState.save());
}
