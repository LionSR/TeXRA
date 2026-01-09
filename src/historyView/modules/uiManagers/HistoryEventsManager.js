// Local imports - history view
import { ELEMENT_IDS } from '../constants.js';
import { addEventListenerSafely } from '@common/domUtils.js';
import { debounce } from '@common/debounce.js';

/**
 * Registers global event listeners for the history view.
 */
export class HistoryEventsManager {
  constructor(searchManager) {
    this.searchManager = searchManager;
    this.handlers = [];
  }

  setup() {
    const searchHandler = debounce((e) => {
      this.searchManager.search(e.target.value.trim());
    }, 300);

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

    this._registerHandler(ELEMENT_IDS.SEARCH_INPUT, 'input', searchHandler);
    this._registerHandler(ELEMENT_IDS.SEARCH_INPUT, 'keydown', keyHandler);
    this._registerHandler(ELEMENT_IDS.PREV_MATCH, 'click', () =>
      this.searchManager.navigatePrev(),
    );
    this._registerHandler(ELEMENT_IDS.NEXT_MATCH, 'click', () =>
      this.searchManager.navigateNext(),
    );
  }

  _registerHandler(elementId, eventType, handler) {
    addEventListenerSafely(elementId, eventType, handler);
    const element = document.getElementById(elementId);
    if (element) {
      this.handlers.push({ element, type: eventType, handler });
    }
  }

  dispose() {
    this.handlers.forEach(({ element, type, handler }) => {
      element.removeEventListener(type, handler);
    });
    this.handlers = [];
  }
}
