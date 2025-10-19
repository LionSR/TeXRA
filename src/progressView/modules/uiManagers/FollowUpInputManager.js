// Local imports - progress view
import { COMMANDS, ELEMENT_IDS } from '../constants.js';
import { progressViewState } from '../progressViewState.js';
import { RecordingButtonManager } from '@common/modules/RecordingButtonManager.js';
import {
  autoResizeTextarea,
  insertTextAtCursor,
} from '@common/modules/textareaUtils.js';
import {
  addEventListenerSafely,
  safeGetElementById,
} from '@common/domUtils.js';
import { vscode } from '@common/webviewContext.js';

export class FollowUpInputManager {
  constructor(vscodeInstance = vscode, state = progressViewState) {
    this.vscode = vscodeInstance;
    this.state = state;
    this.textarea = null;
    this.sendButton = null;
    this.polishButton = null;
    this.container = null;
    this.enabled = false;
    this.pendingRecordingState = undefined;
    this.recordingButtonInitialized = false;
    this.recordingButton = new RecordingButtonManager({
      vscode: this.vscode,
      buttonId: ELEMENT_IDS.RECORD_FOLLOW_UP_BUTTON,
      startCommand: COMMANDS.START_RECORDING,
      stopCommand: COMMANDS.STOP_RECORDING,
      idleTitle: 'Record follow-up with microphone',
      recordingTitle: 'Stop recording',
      createMessagePayload: () => ({ stream: this.state.activeStream }),
    });
  }

  setup() {
    this.textarea = safeGetElementById(ELEMENT_IDS.FOLLOW_UP_INPUT);
    this.sendButton = safeGetElementById(ELEMENT_IDS.SEND_FOLLOW_UP_BTN);
    this.polishButton = safeGetElementById(ELEMENT_IDS.POLISH_FOLLOW_UP_BUTTON);
    this.container = safeGetElementById(ELEMENT_IDS.FOLLOW_UP_CONTAINER);

    if (!this.textarea) {
      return;
    }

    autoResizeTextarea(this.textarea);
    addEventListenerSafely(ELEMENT_IDS.FOLLOW_UP_INPUT, 'input', () => {
      autoResizeTextarea(this.textarea);
    });

    addEventListenerSafely(ELEMENT_IDS.FOLLOW_UP_INPUT, 'keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        this.sendFollowUp();
      }
    });

    addEventListenerSafely(ELEMENT_IDS.SEND_FOLLOW_UP_BTN, 'click', () => {
      this.sendFollowUp();
    });

    addEventListenerSafely(ELEMENT_IDS.POLISH_FOLLOW_UP_BUTTON, 'click', () => {
      this.requestPolish();
    });

    this.recordingButton.setup();
    this.recordingButtonInitialized = true;
    if (this.pendingRecordingState !== undefined) {
      this.recordingButton.setRecording(this.pendingRecordingState);
      this.pendingRecordingState = undefined;
    }

    this._applyEnabledState();
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    this._applyEnabledState();
    if (!this.enabled && this.recordingButtonInitialized) {
      if (this.recordingButton.isRecordingActive()) {
        this.recordingButton.stopRecording();
      }
      this.clear();
    }
  }

  sendFollowUp() {
    if (!this.enabled || !this.textarea) {
      return;
    }
    const stream = this.state.activeStream;
    const text = this.textarea.value.trim();
    if (!stream || !text) {
      return;
    }
    this.vscode.postMessage({
      command: COMMANDS.SEND_FOLLOW_UP,
      stream,
      text,
    });
    this.clear();
  }

  requestPolish() {
    if (!this.enabled || !this.textarea) {
      return;
    }
    const stream = this.state.activeStream;
    const text = this.textarea.value.trim();
    if (!stream || !text) {
      return;
    }
    this.vscode.postMessage({
      command: COMMANDS.POLISH_FOLLOW_UP,
      stream,
      text,
    });
  }

  insertTranscription(text) {
    if (!this.textarea) {
      return;
    }
    insertTextAtCursor(this.textarea, text);
    autoResizeTextarea(this.textarea);
    this.textarea.focus();
  }

  applyPolishedText(text) {
    if (!this.textarea) {
      return;
    }
    this.textarea.value = text;
    autoResizeTextarea(this.textarea);
    const end = this.textarea.value.length;
    this.textarea.setSelectionRange(end, end);
    this.textarea.focus();
  }

  setRecording(recording) {
    if (!this.recordingButtonInitialized) {
      this.pendingRecordingState = recording;
      return;
    }
    this.recordingButton.setRecording(recording);
  }

  stopRecording() {
    if (!this.recordingButtonInitialized) {
      this.pendingRecordingState = false;
      return;
    }
    if (this.recordingButton.isRecordingActive()) {
      this.recordingButton.stopRecording();
    } else {
      this.recordingButton.setRecording(false);
    }
  }

  clear() {
    if (!this.textarea) {
      return;
    }
    this.textarea.value = '';
    autoResizeTextarea(this.textarea);
  }

  _applyEnabledState() {
    const disabled = !this.enabled;
    if (this.textarea) {
      this.textarea.disabled = disabled;
    }
    if (this.sendButton) {
      this.sendButton.disabled = disabled;
    }
    if (this.polishButton) {
      this.polishButton.disabled = disabled;
    }
    const recordButton = safeGetElementById(
      ELEMENT_IDS.RECORD_FOLLOW_UP_BUTTON,
    );
    if (recordButton) {
      recordButton.disabled = disabled;
    }
  }
}
