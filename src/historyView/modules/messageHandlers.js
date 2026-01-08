// Local imports - history view
import { historyViewDomHandler } from './domHandlers.js';
// Local imports - common
import { HISTORY_VIEW_COMMANDS } from '@common/webview/commands.js';
import { createMessageHandler } from '@common/messageHandlerFactory.js';

function handleUpdateHistory(message) {
  historyViewDomHandler.renderer.render(message.historyItems);
}

function handleHistoryCleared() {
  historyViewDomHandler.renderer.render([]);
}

export const messageHandler = createMessageHandler({
  [HISTORY_VIEW_COMMANDS.UPDATE_HISTORY]: handleUpdateHistory,
  [HISTORY_VIEW_COMMANDS.HISTORY_CLEARED]: handleHistoryCleared,
});
