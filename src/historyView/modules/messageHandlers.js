// Local imports
import { registerMessageHandlers } from '@common/webviewContext.js';
import { historyViewDomHandler } from './domHandlers.js';

/**
 * Handles messages from the extension for the history view.
 */
export class HistoryViewMessageHandlers {
  constructor() {
    this._cleanupFn = null;
    this._handlers = {
      updateHistory: (m) => this.handleUpdateHistory(m),
      historyCleared: () => this.handleHistoryCleared(),
    };
  }

  setup() {
    this._cleanupFn = registerMessageHandlers(this._handlers);
  }

  cleanup() {
    if (this._cleanupFn) {
      this._cleanupFn();
      this._cleanupFn = null;
    }
  }

  handleUpdateHistory(message) {
    historyViewDomHandler.renderer.render(message.historyItems);
  }

  handleHistoryCleared() {
    historyViewDomHandler.renderer.render([]);
  }
}

export const messageHandlers = new HistoryViewMessageHandlers();
