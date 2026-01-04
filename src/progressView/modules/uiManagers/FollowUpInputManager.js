// Local imports - progress view
import { COMMANDS, ELEMENT_IDS } from '../constants.js';
import { progressViewState } from '../progressViewState.js';

// Local imports - common helpers
import {
  awaitTextareaUpgrade,
  insertTextAtCursor,
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
    this.approvalBypassButton = null;
    this._isContainerVisible = false;
    this._focusTimer = null;
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
    this.approvalBypassButton = safeGetElementById(
      ELEMENT_IDS.RESET_APPROVAL_BYPASS_BTN,
    );

    const applySetup = () => {
      const { textarea } = resolveTextareaTarget(target);
      if (!textarea) {
        return;
      }

      addEventListenerSafely(ELEMENT_IDS.SEND_FOLLOW_UP_BTN, 'click', () => {
        this._sendFollowUp();
      });

      addEventListenerSafely(
        ELEMENT_IDS.FOLLOW_UP_INPUT,
        'keydown',
        (event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            this._sendFollowUp();
          }
        },
      );

      addEventListenerSafely(ELEMENT_IDS.POLISH_FOLLOW_UP_BTN, 'click', () => {
        this._polishFollowUp();
      });

      addEventListenerSafely(ELEMENT_IDS.CLEAR_FOLLOW_UP_BTN, 'click', () => {
        this._clearFollowUp();
      });

      addEventListenerSafely(
        ELEMENT_IDS.RESET_APPROVAL_BYPASS_BTN,
        'click',
        () => {
          this._resetApprovalBypass();
        },
      );

      this.recordingButton.setup();
    };

    awaitTextareaUpgrade(target, () => applySetup());
  }

  _sendFollowUp() {
    if (!this.textarea) return;

    const text = this.textarea.value.trim();
    const stream = progressViewState.activeStream;
    if (!text) {
      return;
    }
    if (!stream) {
      console.warn(
        '[FollowUpInputManager] Cannot send follow-up: no active stream',
      );
      return;
    }

    this.vscode.postMessage({
      command: COMMANDS.SEND_FOLLOW_UP,
      stream,
      text,
    });

    this.textarea.value = '';
  }

  _polishFollowUp() {
    if (!this.textarea) return;

    const text = this.textarea.value.trim();
    const stream = progressViewState.activeStream;
    if (!text || !stream) {
      return;
    }

    // Show progress indicator
    const progressContainer = document.getElementById(
      'polishFollowUpProgressContainer',
    );
    if (progressContainer) {
      progressContainer.style.display = 'block';
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
    this.focus();
  }

  _resetApprovalBypass() {
    this.vscode.postMessage({
      command: COMMANDS.RESET_TOOL_EDIT_APPROVAL_BYPASS,
    });
  }

  setRecording(recording) {
    this.recordingButton.setRecording(recording);
  }

  setContainerVisibility(isVisible) {
    this._isContainerVisible = Boolean(isVisible);
    if (!this._isContainerVisible) {
      this._clearPendingFocus();
    }
  }

  focus(options = {}) {
    if (!this.textarea || !this._isContainerVisible) {
      return;
    }

    const { scrollIntoView = false } = options;

    this._clearPendingFocus();

    this._focusTimer = window.setTimeout(() => {
      this._focusTimer = null;
      if (!this.textarea || !this._isContainerVisible) {
        return;
      }

      this.textarea.focus();

      if (
        scrollIntoView &&
        typeof this.textarea.scrollIntoView === 'function'
      ) {
        this.textarea.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }, 0);
  }

  _clearPendingFocus() {
    if (this._focusTimer) {
      clearTimeout(this._focusTimer);
      this._focusTimer = null;
    }
  }

  applyPolishedText(text) {
    if (!this.textarea || typeof text !== 'string') {
      return;
    }

    // Hide progress indicator
    const progressContainer = document.getElementById(
      'polishFollowUpProgressContainer',
    );
    if (progressContainer) {
      progressContainer.style.display = 'none';
    }

    this.textarea.value = text;
    this.focus({ scrollIntoView: true });
  }

  insertTranscription(text) {
    if (!this.textarea || typeof text !== 'string') {
      return;
    }

    insertTextAtCursor(this.textarea, text);
    this.focus({ scrollIntoView: true });
  }

  setApprovalBypassState(isBypassed) {
    const button = this.approvalBypassButton;
    if (!button) {
      return;
    }

    const showButton = Boolean(isBypassed);
    button.toggleAttribute('hidden', !showButton);
    button.toggleAttribute('disabled', !showButton);
  }
}
