// Local imports - progress view
import { COMMANDS, ELEMENT_IDS, MAX_HEIGHT } from '../constants.js';
import { progressViewState } from '../progressViewState.js';

// Local imports - common
import {
  addEventListenerSafely,
  safeGetElementById,
} from '@common/domUtils.js';
import {
  autoResizeTextarea,
  insertTextAtCursor,
  resetTextareaHeight,
} from '@common/textareaUtils.js';
import { RecordingButtonManager } from '@common/recordingButtonManager.js';
import { vscode } from '@common/webviewContext.js';

const POLISH_SUCCESS_MESSAGE = 'Follow-up text has been polished!';
const TRANSCRIBE_SUCCESS_MESSAGE = 'Follow-up text transcribed!';

export class FollowUpInputManager {
  constructor(vscodeInstance = vscode) {
    this.vscode = vscodeInstance;
    this._textarea = null;
    this._recordingButton = new RecordingButtonManager({
      buttonId: ELEMENT_IDS.RECORD_FOLLOW_UP_BTN,
      vscode: this.vscode,
      startCommand: COMMANDS.START_RECORDING,
      stopCommand: COMMANDS.STOP_RECORDING,
      idleTitle: 'Record follow-up with microphone',
      recordingTitle: 'Stop recording',
    });
  }

  setup() {
    this._textarea = safeGetElementById(ELEMENT_IDS.FOLLOW_UP_INPUT);
    if (!this._textarea) {
      return;
    }

    autoResizeTextarea(this._textarea, MAX_HEIGHT);

    addEventListenerSafely(this._textarea, 'input', () => {
      autoResizeTextarea(this._textarea, MAX_HEIGHT);
    });

    addEventListenerSafely(this._textarea, 'keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        this.sendFollowUp();
      }
    });

    addEventListenerSafely(ELEMENT_IDS.SEND_FOLLOW_UP_BTN, 'click', () => {
      this.sendFollowUp();
    });

    addEventListenerSafely(ELEMENT_IDS.POLISH_FOLLOW_UP_BTN, 'click', () => {
      this.requestPolish();
    });

    this._recordingButton.setup();
  }

  sendFollowUp() {
    if (!this._textarea) {
      return;
    }
    const text = this._textarea.value.trim();
    const stream = progressViewState.activeStream;
    if (!text || !stream) {
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
    if (!this._textarea) {
      return;
    }
    const text = this._textarea.value.trim();
    const stream = progressViewState.activeStream;
    if (!text || !stream) {
      return;
    }
    this.vscode.postMessage({
      command: COMMANDS.POLISH_FOLLOW_UP,
      stream,
      text,
    });
  }

  clear() {
    if (!this._textarea) {
      return;
    }
    this._textarea.value = '';
    resetTextareaHeight(this._textarea);
    autoResizeTextarea(this._textarea, MAX_HEIGHT);
  }

  setRecording(recording) {
    this._recordingButton.setRecording(recording);
  }

  handleRecordingError() {
    this._recordingButton.setRecording(false);
  }

  applyPolishedText(text) {
    if (!this._textarea || typeof text !== 'string') {
      return;
    }
    this._textarea.value = text;
    autoResizeTextarea(this._textarea, MAX_HEIGHT);
    this._textarea.focus();
    this._notifyInfo(POLISH_SUCCESS_MESSAGE);
  }

  appendTranscription(text) {
    if (!this._textarea || typeof text !== 'string') {
      return;
    }
    insertTextAtCursor(this._textarea, text);
    autoResizeTextarea(this._textarea, MAX_HEIGHT);
    this._textarea.focus();
    this._recordingButton.setRecording(false);
    this._notifyInfo(TRANSCRIBE_SUCCESS_MESSAGE);
  }

  _notifyInfo(message) {
    if (!message) {
      return;
    }
    this.vscode.postMessage({
      command: COMMANDS.SHOW_INFORMATION_MESSAGE,
      text: message,
    });
  }
}
