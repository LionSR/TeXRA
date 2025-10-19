// Local imports - common
import { addEventListenerSafely, safeGetElementById } from './domUtils.js';
import { createCodicon } from './templateUtils.js';

const DEFAULT_IDLE_ICON = 'mic';
const DEFAULT_RECORDING_ICON = 'stop-circle';
const RECORDING_EVENT = 'recordingUIUpdate';

/**
 * Lightweight controller for a recording toggle button shared across webviews.
 */
export class RecordingButtonManager {
  constructor({
    buttonId,
    vscode,
    startCommand,
    stopCommand,
    eventTarget,
    idleIcon = DEFAULT_IDLE_ICON,
    recordingIcon = DEFAULT_RECORDING_ICON,
    idleTitle = 'Record with microphone',
    recordingTitle = 'Stop recording',
    recordingClass = 'recording',
  }) {
    this.buttonId = buttonId;
    this.vscode = vscode;
    this.startCommand = startCommand;
    this.stopCommand = stopCommand;
    this.eventTarget = eventTarget;
    this.idleIcon = idleIcon;
    this.recordingIcon = recordingIcon;
    this.idleTitle = idleTitle;
    this.recordingTitle = recordingTitle;
    this.recordingClass = recordingClass;
    this.isRecording = false;
  }

  setup() {
    const button = safeGetElementById(this.buttonId);
    if (!button) {
      return;
    }

    this._render();

    addEventListenerSafely(this.buttonId, 'click', () => {
      const nextState = !this.isRecording;
      this.vscode.postMessage({
        command: nextState ? this.startCommand : this.stopCommand,
      });
      this._emitRecordingState(nextState);
    });

    if (this.eventTarget) {
      this.eventTarget.addEventListener(RECORDING_EVENT, (event) => {
        const recording = Boolean(event?.detail?.recording);
        this.setRecording(recording);
      });
    }
  }

  setRecording(recording) {
    this.isRecording = Boolean(recording);
    this._render();
  }

  _emitRecordingState(recording) {
    this.setRecording(recording);
    if (this.eventTarget) {
      this.eventTarget.dispatchEvent(
        new CustomEvent(RECORDING_EVENT, { detail: { recording } }),
      );
    }
  }

  _render() {
    const button = safeGetElementById(this.buttonId);
    if (!button) {
      return;
    }
    button.innerHTML = '';
    const iconName = this.isRecording ? this.recordingIcon : this.idleIcon;
    const icon = createCodicon(iconName);
    if (icon) {
      button.appendChild(icon);
    }
    button.title = this.isRecording ? this.recordingTitle : this.idleTitle;
    button.classList.toggle(this.recordingClass, this.isRecording);
  }
}
