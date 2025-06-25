import { vscode } from '@common/webviewContext.js';
import { webviewState } from './webviewState.js';
import { MULTIPLE_SELECTIONS } from './constants.js';
import { safeGetElementById } from '@common/domUtils.js';
import { InstructionManager } from './uiManagers/InstructionManager.js';
import { ToggleManager } from './uiManagers/ToggleManager.js';
import { RecordingManager } from './uiManagers/RecordingManager.js';
import { webviewEventBus } from './eventBus.js';
import { FileInputManager } from './uiManagers/FileInputManager.js';
import { ActionButtonManager } from './uiManagers/ActionButtonManager.js';
import { SettingsButtonManager } from './uiManagers/SettingsButtonManager.js';

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
  MULTIPLE_SELECTIONS.forEach((id) => {
    const element = safeGetElementById(id);
    if (element) {
      new Sortable(element, {
        animation: 150,
        onEnd: () => webviewState.save(),
      });
    }
  });

  updateDebugButtonVisibility();

  const fileInputMgr = new FileInputManager();
  const actionButtonMgr = new ActionButtonManager();
  const settingsButtonMgr = new SettingsButtonManager(toggleManager);

  fileInputMgr.setup();
  actionButtonMgr.setup(instructionManager, webviewState);
  settingsButtonMgr.setup();
  recordingManager.setupRecordButton();
}
