import { vscode } from '@common/webviewContext.js';
import { webviewState } from './webviewState.js';
import { ELEMENTS_TO_SAVE } from './constants.js';
import {
  safeGetElementById,
  addEventListenerSafely,
  safeGetElementValue,
} from '@common/domUtils.js';
import { InstructionManager } from './uiManagers/InstructionManager.js';
import { ToggleManager } from './uiManagers/ToggleManager.js';
import { RecordingManager } from './uiManagers/RecordingManager.js';
import { webviewEventBus } from './eventBus.js';
import { FileInputManager } from './uiManagers/FileInputManager.js';
import { ActionButtonManager } from './uiManagers/ActionButtonManager.js';
import { SettingsButtonManager } from './uiManagers/SettingsButtonManager.js';
import { fileList } from './uiManagers/FileList.js';
import { fileSelect } from './uiManagers/FileSelect.js';

export const instructionManager = new InstructionManager(
  'instruction',
  vscode,
  webviewState,
);
export const toggleManager = new ToggleManager();
export const recordingManager = new RecordingManager(vscode, webviewEventBus);

export let fileInputManager;
export let actionButtonManager;
export let settingsButtonManager;

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
  fileInputManager = new FileInputManager(
    vscode,
    webviewState,
    fileList,
    fileSelect,
  );
  actionButtonManager = new ActionButtonManager(
    vscode,
    fileInputManager,
    fileList,
  );
  settingsButtonManager = new SettingsButtonManager(vscode, toggleManager);

  updateDebugButtonVisibility();

  fileInputManager.setup();
  actionButtonManager.setup();
  settingsButtonManager.setup();

  recordingManager.setupRecordButton();

  addEventListenerSafely('eraseInstructionButton', 'click', () => {
    const instruction = safeGetElementById('instruction');
    if (instruction) {
      instruction.value = '';
      instructionManager.autoResizeTextarea(instruction);
      webviewState.save();
    }
  });

  addEventListenerSafely('magicPolishButton', 'click', () => {
    const instruction = safeGetElementById('instruction');
    if (instruction && instruction.value.trim()) {
      const agent = safeGetElementValue('agent');
      const model = safeGetElementValue('model');
      const singleFiles = fileInputManager.getSingleFileData();
      const multipleFilesData =
        fileInputManager.getMultipleFileData(singleFiles);

      vscode.postMessage({
        command: 'polishInstructionText',
        text: instruction.value,
        agent,
        model,
        ...singleFiles,
        ...multipleFilesData,
      });
    }
  });

  ELEMENTS_TO_SAVE.forEach((id) => {
    if (id !== 'instruction') {
      addEventListenerSafely(id, 'change', () => webviewState.save());
    }
  });

  addEventListenerSafely('instruction', 'input', () => webviewState.save());
}
