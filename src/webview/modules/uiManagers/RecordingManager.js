import {
  addEventListenerSafely,
  safeGetElementById,
} from '@common/domUtils.js';
import { ELEMENT_IDS } from '../constants.js';
import { webviewEventBus } from '../eventBus.js';

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
      if (recording) {
        recordButton.innerHTML = '<i class="codicon codicon-stop-circle"></i>';
        recordButton.title = 'Stop recording';
        recordButton.classList.add('recording');
      } else {
        recordButton.innerHTML = '<i class="codicon codicon-mic"></i>';
        recordButton.title = 'Record instruction with microphone';
        recordButton.classList.remove('recording');
      }
    }
  }

  setupRecordButton() {
    const buttonId = ELEMENT_IDS.RECORD_INSTRUCTION_BUTTON;
    const button = safeGetElementById(buttonId);
    if (!button) return;

    addEventListenerSafely(buttonId, 'click', () => {
      const nextState = !this.isRecording;
      this.vscode.postMessage({
        command: nextState ? 'startRecording' : 'stopRecording',
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
