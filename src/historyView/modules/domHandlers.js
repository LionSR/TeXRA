// Local imports
import { HistoryRenderer } from './historyRenderer.js';
import { SearchManager } from './searchManager.js';
import { HistoryEvents } from './historyEvents.js';
import { historyViewState } from './historyViewState.js';

/**
 * Coordinates the history view DOM managers.
 */
export class HistoryViewDomHandler {
  constructor() {
    this.searchManager = new SearchManager(historyViewState);
    this.renderer = new HistoryRenderer(this.searchManager);
    this.events = new HistoryEvents(this.searchManager);
  }
}

export const historyViewDomHandler = new HistoryViewDomHandler();
