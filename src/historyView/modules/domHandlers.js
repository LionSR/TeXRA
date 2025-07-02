// Local imports
import { HistoryRenderer } from './uiManagers/historyRenderer.js';
import { SearchManager } from './uiManagers/searchManager.js';
import { HistoryEvents } from './uiManagers/Events.js';
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
