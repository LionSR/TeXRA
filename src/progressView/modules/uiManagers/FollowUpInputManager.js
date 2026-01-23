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
    this.yoloToggleButton = null;
    this._isContainerVisible = false;
    this._focusTimer = null;
    this._isYoloActive = false;
    this.recordingButton = new RecordingButtonManager(vscode, {
      buttonId: ELEMENT_IDS.RECORD_FOLLOW_UP_BTN,
      startCommand: COMMANDS.START_RECORDING,
      stopCommand: COMMANDS.STOP_RECORDING,
      startTitle: 'Record follow-up with microphone',
      stopTitle: 'Stop recording',
    });
  }

  setup() {
    // Setup YOLO toggle button (in header, independent of follow-up input)
    this._setupYoloToggleButton();

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

      this.recordingButton.setup();
    };

    awaitTextareaUpgrade(target, () => applySetup());
  }

  _setupYoloToggleButton() {
    this.yoloToggleButton = safeGetElementById(ELEMENT_IDS.YOLO_TOGGLE_BTN);
    if (!this.yoloToggleButton) {
      return;
    }

    addEventListenerSafely(ELEMENT_IDS.YOLO_TOGGLE_BTN, 'click', () => {
      this._toggleApprovalBypass();
    });
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

  _toggleApprovalBypass() {
    const stream = progressViewState.activeStream;
    if (!stream) {
      console.warn(
        '[FollowUpInputManager] Cannot toggle YOLO mode: no active stream',
      );
      return;
    }
    this.vscode.postMessage({
      command: COMMANDS.TOGGLE_TOOL_EDIT_APPROVAL_BYPASS,
      stream,
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
    if (!this.textarea || !this._isContainerVisible) return;

    this._clearPendingFocus();
    this._focusTimer = window.setTimeout(() => {
      this._focusTimer = null;
      if (!this.textarea || !this._isContainerVisible) return;

      this.textarea.focus();
      if (options.scrollIntoView) {
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
    this._isYoloActive = Boolean(isBypassed);

    // Always get a fresh reference to handle cases where setup() hasn't run yet
    // or the button reference became stale
    const button =
      this.yoloToggleButton || safeGetElementById(ELEMENT_IDS.YOLO_TOGGLE_BTN);
    if (!button) {
      return;
    }

    // Update button appearance based on YOLO mode state
    button.classList.toggle('is-active', this._isYoloActive);

    if (this._isYoloActive) {
      // Change icon to flame when active for more visibility
      button.setAttribute('icon', 'flame');
      button.setAttribute('label', 'YOLO mode ON');
      button.setAttribute(
        'title',
        'YOLO mode active - click to disable (resume approval prompts)',
      );
    } else {
      // Shield icon when inactive
      button.setAttribute('icon', 'shield');
      button.setAttribute('label', 'Enable YOLO');
      button.setAttribute('title', 'Enable YOLO mode (skip approval prompts)');
    }
  }

  /**
   * Save the current textarea text to state for the given stream.
   * @param {string} streamId - The stream ID to save text for
   */
  saveTextForStream(streamId) {
    if (!this.textarea || !streamId) {
      return;
    }
    progressViewState.setFollowUpText(streamId, this.textarea.value);
  }

  /**
   * Restore the textarea text from state for the given stream.
   * @param {string} streamId - The stream ID to restore text for
   */
  restoreTextForStream(streamId) {
    if (!this.textarea) {
      return;
    }
    const text = progressViewState.getFollowUpText(streamId);
    this.textarea.value = text || '';
  }

  /**
   * Get the current textarea value.
   * @returns {string} The current textarea text
   */
  getText() {
    return this.textarea?.value || '';
  }

  /**
   * Set the textarea value.
   * @param {string} text - The text to set
   */
  setText(text) {
    if (this.textarea) {
      this.textarea.value = text || '';
    }
  }
}
