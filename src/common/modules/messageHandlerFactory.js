// Local imports - common
import { BaseWebviewMessageHandler } from './BaseWebviewMessageHandler.js';

/**
 * Create a webview message handler instance for a handler map.
 * @param {Record<string, Function>} handlers
 * @returns {BaseWebviewMessageHandler}
 */
export function createMessageHandler(handlers) {
  class ViewMessageHandler extends BaseWebviewMessageHandler {
    constructor() {
      super();
      this._handlers = handlers;
    }
  }

  return new ViewMessageHandler();
}
