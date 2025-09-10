// Local imports - progress view
import { ELEMENT_IDS } from '../constants.js';
import { safeGetElementById } from '@common/domUtils.js';

/**
 * Manages the empty state placeholder in the log view.
 */
export class Placeholder {
  constructor() {
    /** @type {HTMLElement|null} */
    this._element = null;
  }

  /**
   * Show the placeholder inside the log content container.
   */
  show() {
    const container = safeGetElementById(ELEMENT_IDS.LOG_CONTENT);
    if (!container) return;

    if (!this._element) {
      this._element = document.createElement('div');
      this._element.id = ELEMENT_IDS.LOG_PLACEHOLDER;
      this._element.className = 'log-placeholder';
      const sampleLink =
        '<a href="command:texra.createSampleProject">create a sample project</a>';
      const guideArgs = encodeURIComponent(JSON.stringify(['quick-start']));
      const guideLink = `<a href="command:texra.openDoc?${guideArgs}">user guide</a>`;
      this._element.innerHTML = `No runs yet—use TeXRA commands to start. Try ${sampleLink} or read the ${guideLink}.`;
    }

    container.innerHTML = '';
    container.appendChild(this._element);
  }

  /**
   * Hide the placeholder if it is currently shown.
   */
  hide() {
    if (this._element && this._element.parentElement) {
      this._element.parentElement.removeChild(this._element);
    }
  }
}
