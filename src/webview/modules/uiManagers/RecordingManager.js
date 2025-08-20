// Local imports - webview
import { ELEMENT_IDS } from '../constants.js';
import { webviewEventBus } from '../eventBus.js';
import {
  addEventListenerSafely,
  safeGetElementById,
} from '@common/domUtils.js';
import { createCodicon } from '@common/templateUtils.js';
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands.js';

export class RecordingManager {
  constructor(vscode, eventBus = webviewEventBus) {
    this.vscode = vscode;
    this.eventBus = eventBus;
    this.isRecording = false;
  }

  updateRecordingUI(recording) {
    this.isRecording = recording;
    const recordButton = safeGetElementById(
      ELEMENT_IDS.RECORD_INSTRUCTION_BUTTON,
    );
    if (recordButton) {
      recordButton.innerHTML = '';
      const iconName = recording ? 'stop-circle' : 'mic';
      const icon = createCodicon(iconName);
      if (icon) recordButton.appendChild(icon);
      recordButton.title = recording
        ? 'Stop recording'
        : 'Record instruction with microphone';
      recordButton.classList.toggle('recording', recording);
    }
  }

  setupRecordButton() {
    const buttonId = ELEMENT_IDS.RECORD_INSTRUCTION_BUTTON;
    const button = safeGetElementById(buttonId);
    if (!button) return;

    addEventListenerSafely(buttonId, 'click', () => {
      const nextState = !this.isRecording;
      this.vscode.postMessage({
        command: nextState
          ? MAIN_VIEW_COMMANDS.START_RECORDING
          : MAIN_VIEW_COMMANDS.STOP_RECORDING,
      });
      this.eventBus.dispatchEvent(
        new CustomEvent('recordingUIUpdate', {
          detail: { recording: nextState },
        }),
      );
    });

    this.eventBus.addEventListener('recordingUIUpdate', (e) => {
      this.updateRecordingUI(e.detail.recording);
    });
  }
}
