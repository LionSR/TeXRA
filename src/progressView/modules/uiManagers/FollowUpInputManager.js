// Local imports - progress view
import { COMMANDS, ELEMENT_IDS } from '../constants.js';
import { progressViewState } from '../progressViewState.js';

// Local imports - common helpers
import {
  autoResizeTextarea,
  insertTextAtCursor,
  resetTextareaHeight,
  resolveTextareaTarget,
} from '@common/textareaUtils.js';
import {
  addEventListenerSafely,
  safeGetElementById,
} from '@common/domUtils.js';
import { RecordingButtonManager } from '@common/RecordingButtonManager.js';

export class FollowUpInputManager {
  constructor(vscode) {
    this.vscode = vscode;
    this.textarea = null;
    this.recordingButton = new RecordingButtonManager(vscode, {
      buttonId: ELEMENT_IDS.RECORD_FOLLOW_UP_BTN,
      startCommand: COMMANDS.START_RECORDING,
      stopCommand: COMMANDS.STOP_RECORDING,
      startTitle: 'Record follow-up with microphone',
      stopTitle: 'Stop recording',
    });
  }

  setup() {
    const target = safeGetElementById(ELEMENT_IDS.FOLLOW_UP_INPUT);
    if (!target) {
      return;
    }

    this.textarea = target;

    const applySetup = () => {
      const { textarea } = resolveTextareaTarget(target);
      if (!textarea) {
        return;
      }

      autoResizeTextarea(target);

      addEventListenerSafely(ELEMENT_IDS.FOLLOW_UP_INPUT, 'input', () => {
        autoResizeTextarea(target);
      });

      addEventListenerSafely(ELEMENT_IDS.SEND_FOLLOW_UP_BTN, 'click', () => {
        this._sendFollowUp();
      });

      addEventListenerSafely(ELEMENT_IDS.FOLLOW_UP_INPUT, 'keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          this._sendFollowUp();
        }
      });

      addEventListenerSafely(ELEMENT_IDS.POLISH_FOLLOW_UP_BTN, 'click', () => {
        this._polishFollowUp();
      });

      addEventListenerSafely(ELEMENT_IDS.CLEAR_FOLLOW_UP_BTN, 'click', () => {
        this._clearFollowUp();
      });

      this.recordingButton.setup();
    };

    const needsUpgrade =
      target.tagName?.toLowerCase?.() === 'vscode-textarea' &&
      typeof target.updateComplete?.then === 'function';

    if (needsUpgrade) {
      target.updateComplete.then(() => applySetup());
    } else {
      applySetup();
    }
  }

  _sendFollowUp() {
    if (!this.textarea) return;

    const text = this.textarea.value.trim();
    const stream = progressViewState.activeStream;
    if (!text || !stream) {
      return;
    }

    this.vscode.postMessage({
      command: COMMANDS.SEND_FOLLOW_UP,
      stream,
      text,
    });

    this.textarea.value = '';
    resetTextareaHeight(this.textarea);
  }

  _polishFollowUp() {
    if (!this.textarea) return;

    const text = this.textarea.value.trim();
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

  _clearFollowUp() {
    if (!this.textarea) return;

    this.textarea.value = '';
    resetTextareaHeight(this.textarea);
    this.textarea.focus();
  }

  setRecording(recording) {
    this.recordingButton.setRecording(recording);
  }

  applyPolishedText(text) {
    if (!this.textarea || typeof text !== 'string') {
      return;
    }

    this.textarea.value = text;
    autoResizeTextarea(this.textarea);
    this.textarea.focus();
  }

  insertTranscription(text) {
    if (!this.textarea || typeof text !== 'string') {
      return;
    }

    insertTextAtCursor(this.textarea, text);
    autoResizeTextarea(this.textarea);
    this.textarea.focus();
  }
}
