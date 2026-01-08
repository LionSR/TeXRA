// Local imports - memory view
import { memoryViewDomHandler } from './domHandlers.js';
// Local imports - common
import { MEMORY_VIEW_COMMANDS } from '@common/webview/commands.js';
import { createMessageHandler } from '@common/messageHandlerFactory.js';

function handleUpdateMemory(message) {
  memoryViewDomHandler.renderMemoryItems(message.items);
}

export const messageHandler = createMessageHandler({
  [MEMORY_VIEW_COMMANDS.UPDATE_MEMORY]: handleUpdateMemory,
});
