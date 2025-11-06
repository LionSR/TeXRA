// Local imports - progress view
import { ELEMENT_IDS } from '../constants.js';

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
    const container = document.getElementById(ELEMENT_IDS.LOG_CONTENT);
    if (!container) return;

    if (!this._element) {
      this._element = document.createElement('div');
      this._element.id = ELEMENT_IDS.LOG_PLACEHOLDER;
      this._element.className = 'log-placeholder';
      const walkthroughLink =
        '<a href="command:texra.openGettingStarted">open the getting started walkthrough</a>';
      const sampleLink =
        '<a href="command:texra.createSampleProject">create a sample project</a>';
      const overleafLink =
        '<a href="command:texra.cloneOverleafProject">clone an Overleaf project</a>';
      const arxivLink =
        '<a href="command:texra.downloadArXivSource">download an arXiv source</a>';
      this._element.innerHTML = `No runs yet—use TeXRA commands to start. Try ${walkthroughLink}, ${sampleLink}, ${overleafLink}, or ${arxivLink}.`;
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
