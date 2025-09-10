// Local imports - history view
import { ELEMENT_IDS } from '../constants.js';
// Local imports - common
import { BaseUIManager } from '@common/BaseUIManager.js';

/**
 * Registers global event listeners for the history view.
 */
export class HistoryEventsManager extends BaseUIManager {
  constructor(searchManager) {
    super();
    this.searchManager = searchManager;
  }

  _debounce(fn, delay) {
    let timeout;
    return (...args) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => fn(...args), delay);
    };
  }

  setupEventListeners() {
    const searchHandler = this._debounce((e) => {
      const term = e.target.value.trim();
      this.searchManager.search(term);
    }, 300);
    this.addListener(ELEMENT_IDS.SEARCH_INPUT, 'input', searchHandler);

    const prevHandler = () => this.searchManager.navigatePrev();
    this.addListener(ELEMENT_IDS.PREV_MATCH, 'click', prevHandler);

    const nextHandler = () => this.searchManager.navigateNext();
    this.addListener(ELEMENT_IDS.NEXT_MATCH, 'click', nextHandler);

    const keyHandler = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) {
          this.searchManager.navigatePrev();
        } else {
          this.searchManager.navigateNext();
        }
      }
    };
    this.addListener(ELEMENT_IDS.SEARCH_INPUT, 'keydown', keyHandler);
  }

  dispose() {
    this.cleanup();
  }
}
