// Local imports - common
import { addEventListenerSafely, safeGetElementById } from './domUtils.js';
import { createCodicon } from './templateUtils.js';

/**
 * Lightweight controller for a recording toggle button shared across webviews.
 */
export class RecordingButtonManager {
  constructor({
    vscode,
    buttonId,
    startCommand,
    stopCommand,
    idleTitle = 'Record with microphone',
    recordingTitle = 'Stop recording',
    idleIcon = 'mic',
    recordingIcon = 'stop-circle',
    recordingClass = 'recording',
    eventBus = null,
    eventName = 'recordingUIUpdate',
    createMessagePayload = () => ({}),
  }) {
    this.vscode = vscode;
    this.buttonId = buttonId;
    this.startCommand = startCommand;
    this.stopCommand = stopCommand;
    this.idleTitle = idleTitle;
    this.recordingTitle = recordingTitle;
    this.idleIcon = idleIcon;
    this.recordingIcon = recordingIcon;
    this.recordingClass = recordingClass;
    this.eventBus = eventBus;
    this.eventName = eventName;
    this.createMessagePayload = createMessagePayload;
    this.isRecording = false;
  }

  /**
   * Initialize the button by wiring up event listeners and syncing UI state.
   */
  setup() {
    const button = safeGetElementById(this.buttonId);
    if (!button) {
      return;
    }

    this._render(button);

    addEventListenerSafely(this.buttonId, 'click', () => {
      const target = safeGetElementById(this.buttonId);
      if (target?.disabled) {
        return;
      }
      if (this.isRecording) {
        this.stopRecording();
      } else {
        this.startRecording();
      }
    });

    if (this.eventBus) {
      this.eventBus.addEventListener(this.eventName, (event) => {
        const recording = Boolean(event?.detail?.recording);
        this.setRecording(recording);
      });
    }
  }

  /** Start recording and notify the extension. */
  startRecording() {
    if (this.isRecording) {
      return;
    }
    this.isRecording = true;
    this.vscode.postMessage({
      command: this.startCommand,
      ...this.createMessagePayload(),
    });
    this._render();
    this._dispatchEvent(true);
  }

  /** Stop recording and notify the extension. */
  stopRecording() {
    if (!this.isRecording) {
      return;
    }
    this.isRecording = false;
    this.vscode.postMessage({
      command: this.stopCommand,
      ...this.createMessagePayload(),
    });
    this._render();
    this._dispatchEvent(false);
  }

  /** Update UI state without posting messages. */
  setRecording(recording) {
    this.isRecording = Boolean(recording);
    this._render();
  }

  /** Returns whether the button is currently marked as recording. */
  isRecordingActive() {
    return this.isRecording;
  }

  _dispatchEvent(recording) {
    if (!this.eventBus) {
      return;
    }
    this.eventBus.dispatchEvent(
      new CustomEvent(this.eventName, { detail: { recording } }),
    );
  }

  _render(buttonElement) {
    const button = buttonElement || safeGetElementById(this.buttonId);
    if (!button) {
      return;
    }

    button.innerHTML = '';
    const icon = createCodicon(
      this.isRecording ? this.recordingIcon : this.idleIcon,
    );
    if (icon) {
      button.appendChild(icon);
    }
    button.title = this.isRecording ? this.recordingTitle : this.idleTitle;
    button.classList.toggle(this.recordingClass, this.isRecording);
    button.setAttribute('aria-pressed', this.isRecording ? 'true' : 'false');
  }
}
