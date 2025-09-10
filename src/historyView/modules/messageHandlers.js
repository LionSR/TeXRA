// Local imports - history view
import { historyViewDomHandler } from './domHandlers.js';
import { HISTORY_VIEW_COMMANDS } from '@common/webview/commands.js';
import { BaseWebviewMessageHandler } from '@common/BaseWebviewMessageHandler.js';

/**
 * Handles messages from the extension for the history view.
 */
export class HistoryViewMessageHandler extends BaseWebviewMessageHandler {
  constructor() {
    super();
    this._handlers = {
      [HISTORY_VIEW_COMMANDS.UPDATE_HISTORY]: (m) =>
        this.handleUpdateHistory(m),
      [HISTORY_VIEW_COMMANDS.HISTORY_CLEARED]: () =>
        this.handleHistoryCleared(),
    };
  }

  handleUpdateHistory(message) {
    historyViewDomHandler.renderer.render(message.historyItems);
  }

  handleHistoryCleared() {
    historyViewDomHandler.renderer.render([]);
  }
}

export const messageHandler = new HistoryViewMessageHandler();
