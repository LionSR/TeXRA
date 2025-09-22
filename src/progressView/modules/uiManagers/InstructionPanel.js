// Local imports - progress view
import { ELEMENT_IDS } from '../constants.js';

/**
 * Manages the instruction panel that surfaces the active stream instruction.
 */
export class InstructionPanel {
  constructor() {
    this._container = null;
    this._body = null;
    this._text = null;
    this._toggleButton = null;
    this._toggleLabel = null;
    this._metadata = {};
    this._currentText = '';
    this._expanded = false;
    this._hasOverflow = false;
    this._toggleHandler = this._handleToggle.bind(this);
  }

  _ensureElements() {
    if (!this._container) {
      this._container = document.getElementById(
        ELEMENT_IDS.INSTRUCTION_CONTAINER,
      );
      if (!this._container) {
        console.error('InstructionPanel: container element not found');
        return null;
      }
      this._body = this._container.querySelector('.instruction-panel__body');
      this._text = document.getElementById(ELEMENT_IDS.INSTRUCTION_TEXT);
      this._toggleButton = document.getElementById(
        ELEMENT_IDS.INSTRUCTION_TOGGLE_BTN,
      );
      if (this._toggleButton) {
        this._toggleButton.addEventListener('click', this._toggleHandler);
        this._toggleLabel = this._toggleButton.querySelector(
          '.instruction-panel__toggle-label',
        );
      }
    }

    if (!this._text) {
      console.error('InstructionPanel: text element not found');
      return null;
    }

    return {
      container: this._container,
      body: this._body,
      text: this._text,
      toggle: this._toggleButton,
    };
  }

  /**
   * Display the instruction text with optional metadata.
   * @param {string} text
   * @param {Record<string, any>} metadata
   */
  show(text, metadata = {}) {
    const elements = this._ensureElements();
    if (!elements) {
      return;
    }

    const normalizedText = typeof text === 'string' ? text : '';
    if (!normalizedText.trim()) {
      this.hide();
      return;
    }

    const textChanged = normalizedText !== this._currentText;
    this._currentText = normalizedText;
    this._metadata = metadata || {};

    if (elements.text) {
      elements.text.textContent = normalizedText;
    }

    if (elements.container) {
      elements.container.classList.add('is-visible');
      elements.container.setAttribute('aria-hidden', 'false');
    }

    if (typeof this._metadata.expanded === 'boolean') {
      this._expanded = this._metadata.expanded;
    } else if (textChanged) {
      this._expanded = false;
    }

    const measure =
      typeof window !== 'undefined' && window.requestAnimationFrame
        ? window.requestAnimationFrame.bind(window)
        : (cb) => setTimeout(cb, 0);

    measure(() => {
      this._measureOverflow();
      this._applyExpandedState();
      this._updateToggleVisibility();
    });
  }

  /**
   * Hide the instruction panel.
   */
  hide() {
    const elements = this._ensureElements();
    if (!elements) {
      return;
    }

    this._currentText = '';
    this._metadata = {};
    this._expanded = false;
    this._hasOverflow = false;

    if (elements.text) {
      elements.text.textContent = '';
    }

    if (elements.container) {
      elements.container.classList.remove('is-visible', 'is-expanded');
      elements.container.setAttribute('aria-hidden', 'true');
    }

    if (this._toggleButton) {
      this._toggleButton.classList.add('is-hidden');
      this._toggleButton.setAttribute('aria-hidden', 'true');
      this._toggleButton.setAttribute('aria-expanded', 'false');
      this._updateToggleLabel();
    }
  }

  _handleToggle() {
    this._expanded = !this._expanded;
    this._applyExpandedState();
    this._updateToggleVisibility();
  }

  _measureOverflow() {
    if (!this._container || !this._body) {
      this._hasOverflow = false;
      return;
    }

    const wasExpanded = this._expanded;
    this._container.classList.remove('is-expanded');

    if (typeof this._metadata.showToggle === 'boolean') {
      this._hasOverflow = this._metadata.showToggle;
    } else {
      const scrollHeight = this._body.scrollHeight;
      const clientHeight = this._body.clientHeight;
      this._hasOverflow = scrollHeight > clientHeight + 1;
    }

    if (wasExpanded) {
      this._container.classList.add('is-expanded');
    }
  }

  _applyExpandedState() {
    if (!this._container) {
      return;
    }

    this._container.classList.toggle('is-expanded', this._expanded);

    if (this._toggleButton) {
      this._toggleButton.setAttribute(
        'aria-expanded',
        this._expanded ? 'true' : 'false',
      );
    }

    this._updateToggleLabel();
  }

  _updateToggleLabel() {
    if (!this._toggleButton) {
      return;
    }

    const icon = this._toggleButton.querySelector('.codicon');
    if (icon) {
      icon.classList.remove('codicon-chevron-down', 'codicon-chevron-up');
      icon.classList.add(
        this._expanded ? 'codicon-chevron-up' : 'codicon-chevron-down',
      );
    }

    if (this._toggleLabel) {
      this._toggleLabel.textContent = this._expanded
        ? 'Show less'
        : 'Show more';
    }
  }

  _updateToggleVisibility() {
    if (!this._toggleButton) {
      return;
    }

    const shouldShow =
      typeof this._metadata.showToggle === 'boolean'
        ? this._metadata.showToggle
        : this._hasOverflow;

    this._toggleButton.classList.toggle('is-hidden', !shouldShow);
    this._toggleButton.setAttribute(
      'aria-hidden',
      shouldShow ? 'false' : 'true',
    );
  }

  /** Clean up event listeners */
  cleanup() {
    if (this._toggleButton) {
      this._toggleButton.removeEventListener('click', this._toggleHandler);
    }
    this._container = null;
    this._body = null;
    this._text = null;
    this._toggleButton = null;
    this._toggleLabel = null;
  }
}
