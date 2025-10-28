// Local imports - progress view
import { ELEMENT_IDS } from '../constants.js';
import { copyWithFeedback } from '../utils.js';

// Local imports - shared helpers
import { safeGetElementById } from '@common/domUtils.js';

/**
 * Manages the instruction panel that surfaces the active stream instruction.
 */
export class InstructionPanel {
  constructor() {
    this._elements = null;
    this._currentText = '';

    this._copyHandler = this._handleCopy.bind(this);
  }

  _getElements() {
    if (!this._elements) {
      const container = safeGetElementById(ELEMENT_IDS.INSTRUCTION_CONTAINER);
      const text = safeGetElementById(ELEMENT_IDS.INSTRUCTION_TEXT);

      if (!container || !text) {
        return null;
      }

      const copy = safeGetElementById(ELEMENT_IDS.INSTRUCTION_COPY_BTN);

      if (copy) {
        copy.addEventListener('click', this._copyHandler);
      }

      this._elements = { container, text, copy };
    }

    return this._elements;
  }

  show(text) {
    const elements = this._getElements();
    if (!elements) {
      return;
    }

    const normalized = typeof text === 'string' ? text : '';
    if (!normalized.trim()) {
      this.hide();
      return;
    }

    this._currentText = normalized;

    elements.text.value = normalized;
    elements.container.classList.add('is-visible');
    elements.container.setAttribute('aria-hidden', 'false');

    this._resetCopyButton(false);
  }

  hide() {
    const elements = this._getElements();
    if (!elements) {
      return;
    }

    this._currentText = '';

    elements.text.value = '';
    elements.container.classList.remove('is-visible');
    elements.container.setAttribute('aria-hidden', 'true');

    this._resetCopyButton(true);
  }

  _resetCopyButton(disable) {
    const copy = this._elements?.copy;
    if (!copy) {
      return;
    }

    const timeoutId = copy.dataset.copyResetTimeoutId;
    if (timeoutId) {
      window.clearTimeout(Number(timeoutId));
      delete copy.dataset.copyResetTimeoutId;
    }

    copy.classList.remove('copy-success');
    const defaultTitle =
      copy.dataset.defaultTitle ||
      copy.getAttribute('title') ||
      'Copy instruction';
    copy.setAttribute('title', defaultTitle);
    copy.setAttribute('aria-label', defaultTitle);
    copy.disabled = Boolean(disable);
  }

  async _handleCopy(event) {
    event?.preventDefault?.();
    if (!this._currentText) {
      return;
    }

    const copy = this._elements?.copy;
    if (!copy || copy.disabled) {
      return;
    }

    await copyWithFeedback(copy, this._currentText, {
      defaultTitle:
        copy.dataset.defaultTitle ||
        copy.getAttribute('title') ||
        'Copy instruction',
      successTitle: copy.dataset.successTitle || 'Copied!',
    });
  }

  /** Clean up event listeners */
  cleanup() {
    if (!this._elements) {
      return;
    }

    const { copy } = this._elements;
    if (copy) {
      const timeoutId = copy.dataset.copyResetTimeoutId;
      if (timeoutId) {
        window.clearTimeout(Number(timeoutId));
        delete copy.dataset.copyResetTimeoutId;
      }
      copy.removeEventListener('click', this._copyHandler);
    }

    this._elements = null;
    this._currentText = '';
  }
}
