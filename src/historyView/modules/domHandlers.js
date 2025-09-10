// Local imports - history view
import { historyViewState } from './historyViewState.js';
import { HistoryEventsManager } from './uiManagers/HistoryEventsManager.js';
// Local imports
import { HistoryRenderer } from './uiManagers/HistoryRenderer.js';
import { SearchManager } from './uiManagers/SearchManager.js';
import { BaseDomHandler } from '@common/BaseDomHandler.js';

/**
 * Coordinates the history view DOM managers.
 */
class HistoryViewDomHandler extends BaseDomHandler {
  constructor() {
    const searchManager = new SearchManager(historyViewState);
    super({
      searchManager,
      renderer: new HistoryRenderer(searchManager),
      events: new HistoryEventsManager(searchManager),
    });
  }
}

export const historyViewDomHandler = new HistoryViewDomHandler();
