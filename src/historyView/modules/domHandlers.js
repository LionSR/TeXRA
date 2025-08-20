// Local imports - history view
import { historyViewState } from './historyViewState.js';
import { HistoryEventsManager } from './uiManagers/HistoryEventsManager.js';
// Local imports
import { HistoryRenderer } from './uiManagers/HistoryRenderer.js';
import { SearchManager } from './uiManagers/SearchManager.js';

/**
 * Coordinates the history view DOM managers.
 */
export class HistoryViewDomHandler {
  constructor() {
    this.searchManager = new SearchManager(historyViewState);
    this.renderer = new HistoryRenderer(this.searchManager);
    this.events = new HistoryEventsManager(this.searchManager);
  }
}

export const historyViewDomHandler = new HistoryViewDomHandler();
