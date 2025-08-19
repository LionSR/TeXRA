// Local imports - history view
import { historyViewDomHandler } from './domHandlers.js';
import { HISTORY_VIEW_COMMANDS } from '@common/webview/commands.js';
// Local imports
import { registerMessageHandlers } from '@common/webviewContext.js';

/**
 * Handles messages from the extension for the history view.
 */
export class HistoryViewMessageHandler {
  constructor() {
    this._cleanupFn = null;
    this._handlers = {
      [HISTORY_VIEW_COMMANDS.UPDATE_HISTORY]: (m) =>
        this.handleUpdateHistory(m),
      [HISTORY_VIEW_COMMANDS.HISTORY_CLEARED]: () =>
        this.handleHistoryCleared(),
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

export const messageHandler = new HistoryViewMessageHandler();
