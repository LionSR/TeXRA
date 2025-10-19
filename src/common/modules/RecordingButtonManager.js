// Local imports - DOM helpers
import {
  addEventListenerSafely,
  safeGetElementById,
} from '@common/domUtils.js';
import { createCodicon } from '@common/templateUtils.js';

/**
 * Manages a recording toggle button shared across webviews.
 */
export class RecordingButtonManager {
  constructor(vscode, config) {
    this.vscode = vscode;
    this.buttonId = config.buttonId;
    this.startCommand = config.startCommand;
    this.stopCommand = config.stopCommand;
    this.startTitle = config.startTitle || 'Record with microphone';
    this.stopTitle = config.stopTitle || 'Stop recording';
    this.startIcon = config.startIcon || 'mic';
    this.stopIcon = config.stopIcon || 'stop-circle';
    this.recordingClass = config.recordingClass || 'recording';
    this.isRecording = false;
    this.button = null;
  }

  setup() {
    const button = safeGetElementById(this.buttonId);
    if (!button) {
      return;
    }

    this.button = button;
    this._updateButton();

    addEventListenerSafely(this.buttonId, 'click', () => {
      const nextState = !this.isRecording;
      this.vscode.postMessage({
        command: nextState ? this.startCommand : this.stopCommand,
      });
      this.setRecording(nextState);
    });
  }

  setRecording(recording) {
    this.isRecording = Boolean(recording);
    this._updateButton();
  }

  _updateButton() {
    const button = this.button || safeGetElementById(this.buttonId);
    if (!button) {
      return;
    }

    button.innerHTML = '';
    const iconName = this.isRecording ? this.stopIcon : this.startIcon;
    const icon = createCodicon(iconName);
    if (icon) {
      button.appendChild(icon);
    }
    button.title = this.isRecording ? this.stopTitle : this.startTitle;
    button.classList.toggle(this.recordingClass, this.isRecording);
  }
}
