// Local imports - progress view
import { ELEMENT_IDS } from '../constants.js';

/**
 * Manages the empty state placeholder for the log area.
 */
export class EmptyState {
  constructor() {
    this.id = 'logPlaceholder';
  }

  show() {
    const logContent = document.getElementById(ELEMENT_IDS.LOG_CONTENT);
    if (!logContent) return;
    logContent.innerHTML = '';
    let placeholder = document.getElementById(this.id);
    if (!placeholder) {
      placeholder = document.createElement('div');
      placeholder.id = this.id;
      placeholder.className = 'log-placeholder';
      placeholder.innerHTML =
        'No runs yet—use TeXRA commands to start. <a href="command:texra.createSampleProject">Create sample project</a> or <a href="https://texra.ai/guide/" target="_blank">read the user guide</a>.';
      logContent.appendChild(placeholder);
    } else {
      placeholder.style.display = 'block';
      logContent.appendChild(placeholder);
    }
  }

  hide() {
    const placeholder = document.getElementById(this.id);
    if (placeholder) {
      placeholder.style.display = 'none';
    }
  }
}
