// Local imports - progress view
import { ELEMENT_IDS } from '../constants.js';
import { copyWithFeedback } from '../utils.js';

// Local imports - shared helpers
import { safeGetElementById, setChevronIcon } from '@common/domUtils.js';

const EXPAND_LABEL_COLLAPSED = 'Expand instruction';
const EXPAND_LABEL_EXPANDED = 'Collapse instruction';

/**
 * Manages the instruction panel that surfaces the active stream instruction.
 */
export class InstructionPanel {
  constructor() {
    this._elements = null;
    this._currentText = '';
    this._expanded = false;

    this._toggleHandler = this._handleToggle.bind(this);
    this._copyHandler = this._handleCopy.bind(this);
  }

  _getElements() {
    if (!this._elements) {
      const container = safeGetElementById(ELEMENT_IDS.INSTRUCTION_CONTAINER);
      const text = safeGetElementById(ELEMENT_IDS.INSTRUCTION_TEXT);

      if (!container || !text) {
        return null;
      }

      const body = container.querySelector('.instruction-panel__body');
      const toggle = safeGetElementById(ELEMENT_IDS.INSTRUCTION_TOGGLE_BTN);
      const copy = safeGetElementById(ELEMENT_IDS.INSTRUCTION_COPY_BTN);

      if (toggle) {
        toggle.addEventListener('click', this._toggleHandler);
      }
      if (copy) {
        copy.addEventListener('click', this._copyHandler);
      }

      this._elements = { container, body, text, toggle, copy };
    }

    return this._elements;
  }

  show(text, metadata = {}) {
    const elements = this._getElements();
    if (!elements) {
      return;
    }

    const normalized = typeof text === 'string' ? text : '';
    if (!normalized.trim()) {
      this.hide();
      return;
    }

    const textChanged = normalized !== this._currentText;
    this._currentText = normalized;

    elements.text.value = normalized;
    elements.container.classList.add('is-visible');
    elements.container.setAttribute('aria-hidden', 'false');

    this._resetCopyButton(false);

    if (typeof metadata?.expanded === 'boolean') {
      this._expanded = metadata.expanded;
    } else if (textChanged) {
      this._expanded = false;
    }

    const schedule =
      typeof window !== 'undefined' && window.requestAnimationFrame
        ? window.requestAnimationFrame.bind(window)
        : (cb) => setTimeout(cb, 0);

    schedule(() => {
      const shouldShowToggle = this._computeOverflow(metadata?.showToggle);
      this._setToggleVisibility(shouldShowToggle);
      this._applyExpandedState();
    });
  }

  hide() {
    const elements = this._getElements();
    if (!elements) {
      return;
    }

    this._currentText = '';
    this._expanded = false;

    elements.text.value = '';
    elements.container.classList.remove('is-visible', 'is-expanded');
    elements.container.setAttribute('aria-hidden', 'true');

    this._resetCopyButton(true);
    this._setToggleVisibility(false);
    this._applyExpandedState();
  }

  _computeOverflow(forceValue) {
    if (typeof forceValue === 'boolean') {
      return forceValue;
    }

    const elements = this._elements;
    if (!elements?.container || !elements.body) {
      return false;
    }

    const wasExpanded = this._expanded;
    elements.container.classList.remove('is-expanded');

    const hasOverflow =
      elements.body.scrollHeight > elements.body.clientHeight + 1;

    elements.container.classList.toggle('is-expanded', wasExpanded);
    return hasOverflow;
  }

  _setToggleVisibility(visible) {
    const toggle = this._elements?.toggle;
    if (!toggle) {
      return;
    }

    toggle.classList.toggle('is-hidden', !visible);
    toggle.setAttribute('aria-hidden', visible ? 'false' : 'true');
    if (!visible) {
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-label', EXPAND_LABEL_COLLAPSED);
      toggle.setAttribute('title', EXPAND_LABEL_COLLAPSED);
    }
  }

  _applyExpandedState() {
    const elements = this._elements;
    if (!elements?.container) {
      return;
    }

    elements.container.classList.toggle('is-expanded', this._expanded);

    const toggle = elements.toggle;
    if (!toggle) {
      return;
    }

    const label = this._expanded
      ? EXPAND_LABEL_EXPANDED
      : EXPAND_LABEL_COLLAPSED;

    toggle.setAttribute('aria-expanded', this._expanded ? 'true' : 'false');
    toggle.setAttribute('aria-label', label);
    toggle.setAttribute('title', label);
    setChevronIcon(toggle, this._expanded);
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

  _handleToggle() {
    this._expanded = !this._expanded;
    this._applyExpandedState();
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

    const { toggle, copy } = this._elements;
    if (toggle) {
      toggle.removeEventListener('click', this._toggleHandler);
    }
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
    this._expanded = false;
  }
}
