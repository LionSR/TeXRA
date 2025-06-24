import {
  addEventListenerSafely,
  safeGetElementById,
} from '@common/domUtils.js';

export class RecordingManager {
  constructor(vscode) {
    this.vscode = vscode;
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
    const button = safeGetElementById('recordInstructionButton');
    if (!button) return;

    addEventListenerSafely(button, 'click', () => {
      if (this.isRecording) {
        this.vscode.postMessage({ command: 'stopRecording' });
        this.updateRecordingUI(false);
      } else {
        this.vscode.postMessage({ command: 'startRecording' });
        this.updateRecordingUI(true);
      }
    });

    window.updateRecordingUI = (recording) => this.updateRecordingUI(recording);
  }
}
