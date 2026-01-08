// Local imports - memory view
import { memoryViewDomHandler } from './domHandlers.js';
import { MEMORY_VIEW_COMMANDS } from '@common/webview/commands.js';
import { BaseWebviewMessageHandler } from '@common/BaseWebviewMessageHandler.js';

/**
 * Handles messages from the extension for the memory view.
 */
export class MemoryViewMessageHandler extends BaseWebviewMessageHandler {
  constructor() {
    super();
    this._handlers = {
      [MEMORY_VIEW_COMMANDS.UPDATE_MEMORY]: (m) => this.handleUpdateMemory(m),
    };
  }

  handleUpdateMemory(message) {
    memoryViewDomHandler.renderMemoryItems(message.items);
  }
}

export const messageHandler = new MemoryViewMessageHandler();
