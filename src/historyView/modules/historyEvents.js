import { addEventListenerSafely } from '@common/domUtils.js';

/**
 * Registers global event listeners for the history view.
 */
export class HistoryEvents {
  constructor(searchManager) {
    this.searchManager = searchManager;
  }

  setupEventListeners() {
    addEventListenerSafely('searchInput', 'input', (e) => {
      const term = e.target.value.trim();
      this.searchManager.search(term);
    });

    addEventListenerSafely('prevMatch', 'click', () => {
      this.searchManager.navigatePrev();
    });

    addEventListenerSafely('nextMatch', 'click', () => {
      this.searchManager.navigateNext();
    });

    addEventListenerSafely('searchInput', 'keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) {
          this.searchManager.navigatePrev();
        } else {
          this.searchManager.navigateNext();
        }
      }
    });
  }
}
