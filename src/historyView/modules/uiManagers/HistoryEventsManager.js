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
    const searchInput = document.getElementById(ELEMENT_IDS.SEARCH_INPUT);
    const searchHandler = debounce((e) => {
      const term = e.target.value.trim();
      this.searchManager.search(term);
    }, 300);
    addEventListenerSafely(ELEMENT_IDS.SEARCH_INPUT, 'input', searchHandler);
    if (searchInput) {
      this.handlers.push({
        element: searchInput,
        type: 'input',
        handler: searchHandler,
      });
    }

    const prevHandler = () => this.searchManager.navigatePrev();
    addEventListenerSafely(ELEMENT_IDS.PREV_MATCH, 'click', prevHandler);
    const prevEl = document.getElementById(ELEMENT_IDS.PREV_MATCH);
    if (prevEl)
      this.handlers.push({
        element: prevEl,
        type: 'click',
        handler: prevHandler,
      });

    const nextHandler = () => this.searchManager.navigateNext();
    addEventListenerSafely(ELEMENT_IDS.NEXT_MATCH, 'click', nextHandler);
    const nextEl = document.getElementById(ELEMENT_IDS.NEXT_MATCH);
    if (nextEl)
      this.handlers.push({
        element: nextEl,
        type: 'click',
        handler: nextHandler,
      });

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
    addEventListenerSafely(ELEMENT_IDS.SEARCH_INPUT, 'keydown', keyHandler);
    if (searchInput) {
      this.handlers.push({
        element: searchInput,
        type: 'keydown',
        handler: keyHandler,
      });
    }
  }

  dispose() {
    this.handlers.forEach(({ element, type, handler }) => {
      element.removeEventListener(type, handler);
    });
    this.handlers = [];
  }
}
