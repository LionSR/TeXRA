// Local imports - progress view
import { ELEMENT_IDS } from '../constants.js';

// Local imports - shared helpers
import { safeGetElementById, setVisibilityState } from '@common/domUtils.js';

/**
 * Manages the queued follow-ups display in the progress view.
 * Shows pending messages that will be sent when the agent resumes.
 */
export class QueuedFollowUps {
  constructor() {
    this._elements = null;
    this._currentMessages = [];
  }

  /**
   * Lazily get DOM elements.
   * @returns {{container: HTMLElement, list: HTMLElement}|null}
   */
  _getElements() {
    if (!this._elements) {
      const container = safeGetElementById(
        ELEMENT_IDS.QUEUED_FOLLOW_UPS_COLLAPSIBLE,
      );
      const list = safeGetElementById(ELEMENT_IDS.QUEUED_FOLLOW_UPS_LIST);

      if (!container || !list) {
        return null;
      }

      this._elements = { container, list };
    }

    return this._elements;
  }

  /**
   * Update the queued follow-ups display.
   * Shows all queued messages concatenated into a single preview.
   * @param {string[]} messages - The queued message texts
   */
  update(messages) {
    const elements = this._getElements();
    if (!elements) {
      return;
    }

    this._currentMessages = messages ?? [];

    if (this._currentMessages.length === 0) {
      this.hide();
      return;
    }

    // Concatenate all messages with newlines
    const combinedText = this._currentMessages.join('\n\n');

    // Update the title to show count
    const count = this._currentMessages.length;
    const suffix = count === 1 ? '' : ` (${count} combined)`;
    elements.container.setAttribute('title', `Queued Message${suffix}`);

    // Clear and show single combined message
    elements.list.innerHTML = '';
    const item = this._createMessageItem(combinedText);
    elements.list.appendChild(item);

    this.show();
  }

  /**
   * Create a DOM element for a single queued message.
   * @param {string} text - The message text
   * @returns {HTMLElement}
   */
  _createMessageItem(text) {
    const template = document.getElementById('queuedFollowUpTemplate');
    if (template) {
      const clone = template.content.cloneNode(true);
      const textEl = clone.querySelector('.queued-follow-up-text');
      if (textEl) {
        // Truncate long messages for display
        const displayText =
          text.length > 200 ? text.substring(0, 200) + '...' : text;
        textEl.textContent = displayText;
        textEl.title = text; // Full text in tooltip
      }
      return clone.firstElementChild ?? this._createFallbackItem(text);
    }

    return this._createFallbackItem(text);
  }

  /**
   * Create a fallback DOM element if template is not available.
   * @param {string} text - The message text
   * @returns {HTMLElement}
   */
  _createFallbackItem(text) {
    const item = document.createElement('div');
    item.className = 'queued-follow-up-item';

    const icon = document.createElement('i');
    icon.className = 'codicon codicon-comment queued-follow-up-icon';
    item.appendChild(icon);

    const content = document.createElement('span');
    content.className = 'queued-follow-up-text';
    const displayText =
      text.length > 200 ? text.substring(0, 200) + '...' : text;
    content.textContent = displayText;
    content.title = text;
    item.appendChild(content);

    return item;
  }

  /**
   * Show the queued follow-ups container (vscode-collapsible).
   */
  show() {
    const elements = this._getElements();
    if (!elements) {
      return;
    }

    setVisibilityState(elements.container, true);
  }

  /**
   * Hide the queued follow-ups container (vscode-collapsible).
   */
  hide() {
    const elements = this._getElements();
    if (!elements) {
      return;
    }

    setVisibilityState(elements.container, false);
  }

  /**
   * Clear the queued follow-ups list.
   */
  clear() {
    this._currentMessages = [];
    const elements = this._getElements();
    if (elements) {
      elements.list.innerHTML = '';
    }
    this.hide();
  }

  /**
   * Get the current queued messages.
   * @returns {string[]}
   */
  getMessages() {
    return this._currentMessages;
  }
}
