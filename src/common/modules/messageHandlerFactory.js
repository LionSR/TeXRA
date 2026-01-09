// Local imports - common
import { BaseWebviewMessageHandler } from './BaseWebviewMessageHandler.js';

/**
 * Create a webview message handler instance for a handler map.
 * @param {Record<string, Function>} handlers
 * @returns {BaseWebviewMessageHandler}
 */
export function createMessageHandler(handlers) {
  const instance = new BaseWebviewMessageHandler();
  instance._handlers = handlers;
  return instance;
}
