import {
  addEventListenerSafely,
  safeGetElementById,
} from '@common/domUtils.js';
import { webviewEventBus } from '../eventBus.js';
import { createIcon } from '@common/templateUtils.js';

export class RecordingManager {
  constructor(vscode, eventBus = webviewEventBus) {
    this.vscode = vscode;
    this.eventBus = eventBus;
    this.isRecording = false;
  }

  updateRecordingUI(recording) {
    this.isRecording = recording;
    const recordButton = safeGetElementById('recordInstructionButton');
    if (recordButton) {
      if (recording) {
        recordButton.innerHTML = '';
        const icon = createIcon('codicon-stop-circle');
        if (icon) recordButton.appendChild(icon);
        recordButton.title = 'Stop recording';
        recordButton.classList.add('recording');
      } else {
        recordButton.innerHTML = '';
        const icon = createIcon('codicon-mic');
        if (icon) recordButton.appendChild(icon);
        recordButton.title = 'Record instruction with microphone';
        recordButton.classList.remove('recording');
      }
    }
  }

  setupRecordButton() {
    const buttonId = 'recordInstructionButton';
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
