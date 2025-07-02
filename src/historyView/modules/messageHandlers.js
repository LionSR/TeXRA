// Local imports
import { registerMessageHandlers } from '@common/webviewContext.js';
import { historyViewDomHandler } from './domHandlers.js';
import { COMMANDS } from './constants.js';

/**
 * Handles messages from the extension for the history view.
 */
export class HistoryViewMessageHandlers {
  constructor() {
    this._cleanupFn = null;
    this._handlers = {
      [COMMANDS.UPDATE_HISTORY]: (m) => this.handleUpdateHistory(m),
      [COMMANDS.HISTORY_CLEARED]: () => this.handleHistoryCleared(),
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
