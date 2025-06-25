import { vscode } from '@common/webviewContext.js';
import { webviewState } from './webviewState.js';
import { InstructionManager } from './uiManagers/InstructionManager.js';
import { RecordingManager } from './uiManagers/RecordingManager.js';
import { fileInputManager } from './uiManagers/FileInputManager.js';
import { actionButtonManager } from './uiManagers/ActionButtonManager.js';
import { settingsButtonManager } from './uiManagers/SettingsButtonManager.js';
import { toggleManager } from './uiManagers/ToggleManager.js';
import { webviewEventBus } from './eventBus.js';

export const instructionManager = new InstructionManager(
  'instruction',
  vscode,
  webviewState,
);
export const recordingManager = new RecordingManager(vscode, webviewEventBus);

/**
 * Initialize all UI managers.
 */
export function initializeUI() {
  fileInputManager.setup();
  actionButtonManager.setup();
  settingsButtonManager.setup();
  recordingManager.setupRecordButton();
}

export { toggleManager };
