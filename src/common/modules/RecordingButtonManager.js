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
      // Don't update state optimistically - wait for backend confirmation
    });
  }

  setRecording(recording) {
    this.isRecording = Boolean(recording);
    this._updateButton();
  }

  _updateButton() {
    if (!this.button) {
      return;
    }

    const iconName = this.isRecording ? this.stopIcon : this.startIcon;
    const title = this.isRecording ? this.stopTitle : this.startTitle;
    const isVsCodeButton =
      typeof this.button.tagName === 'string' &&
      this.button.tagName.toLowerCase() === 'vscode-button';

    if (isVsCodeButton) {
      this.button.icon = iconName;
      this.button.iconOnly = true;
      this.button.setAttribute('aria-label', title);
      this.button.title = title;
    } else {
      this.button.innerHTML = '';
      const icon = createCodicon(iconName);
      if (icon) {
        this.button.appendChild(icon);
      }
      this.button.title = title;
    }

    this.button.classList.toggle(this.recordingClass, this.isRecording);
  }

  dispose() {
    // Event listeners added via addEventListenerSafely are automatically managed
    // Just clear the button reference
    this.button = null;
  }
}
