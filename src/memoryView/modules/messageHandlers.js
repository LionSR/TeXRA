// Local imports - memory view
import { memoryViewDomHandler } from './domHandlers.js';
import { ELEMENT_IDS } from './constants.js';
import { MEMORY_VIEW_COMMANDS } from '@common/webview/commands.js';
import { BaseWebviewMessageHandler } from '@common/BaseWebviewMessageHandler.js';
import {
  safeSetElementChecked,
  setElementsDisabled,
} from '@common/domUtils.js';

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

  async handleUpdateMemoryEnabled(message) {
    // Wait for vscode-checkbox web component to be defined before setting state
    // Without this, setting checked on un-upgraded element can be lost during upgrade
    await customElements.whenDefined('vscode-checkbox');
    safeSetElementChecked(ELEMENT_IDS.MEMORY_ENABLED_TOGGLE, message.enabled);
    setElementsDisabled(ELEMENT_IDS.MEMORY_ENABLED_TOGGLE, false);
  }
}

export const messageHandler = new MemoryViewMessageHandler();
