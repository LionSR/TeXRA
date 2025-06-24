import {
  addEventListenerSafely,
  safeGetElementById,
} from '@common/domUtils.js';
import { webviewEventBus } from '../eventBus.js';

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
    const buttonId = 'recordInstructionButton';
    const button = safeGetElementById(buttonId);
    if (!button) return;

    addEventListenerSafely(buttonId, 'click', () => {
      if (this.isRecording) {
        this.vscode.postMessage({ command: 'stopRecording' });
        this.updateRecordingUI(false);
      } else {
        this.vscode.postMessage({ command: 'startRecording' });
        this.updateRecordingUI(true);
      }
    });

    this.eventBus.addEventListener('recordingUIUpdate', (e) => {
      this.updateRecordingUI(e.detail.recording);
    });
  }
}
