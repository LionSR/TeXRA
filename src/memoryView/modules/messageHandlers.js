// Local imports - memory view
import { memoryViewDomHandler } from './domHandlers.js';
import { ELEMENT_IDS } from './constants.js';
import { MEMORY_VIEW_COMMANDS } from '@common/webview/commands.js';
import { BaseWebviewMessageHandler } from '@common/BaseWebviewMessageHandler.js';
import { safeGetElementById, setElementDisabled } from '@common/domUtils.js';

/**
 * Handles messages from the extension for the memory view.
 */
export class MemoryViewMessageHandler extends BaseWebviewMessageHandler {
  constructor() {
    super();
    this._handlers = {
      [MEMORY_VIEW_COMMANDS.UPDATE_MEMORY]: (m) => this.handleUpdateMemory(m),
      [MEMORY_VIEW_COMMANDS.UPDATE_MEMORY_ENABLED]: (m) =>
        this.handleUpdateMemoryEnabled(m),
    };
  }

  handleUpdateMemory(message) {
    memoryViewDomHandler.renderMemoryItems(message.items);
  }

  handleUpdateMemoryEnabled(message) {
    const toggle = safeGetElementById(ELEMENT_IDS.MEMORY_ENABLED_TOGGLE);
    if (toggle) {
      toggle.checked = message.enabled;
      setElementDisabled(toggle, false);
    }
  }
}

export const messageHandler = new MemoryViewMessageHandler();
