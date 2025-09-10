// Local imports - common
import { registerMessageHandlers } from './webviewContext.js';

/**
 * Base class for webview message handlers.
 * Provides default setup and cleanup logic for registering
 * message handlers with the VS Code webview context.
 */
export class BaseWebviewMessageHandler {
  constructor() {
    this._cleanupFn = null;
    this._handlers = {};
  }

  /**
   * Register message handlers with the webview and store the cleanup function.
   */
  setup() {
    if (!this._cleanupFn) {
      this._cleanupFn = registerMessageHandlers(this._handlers);
    }
  }

  /**
   * Remove previously registered message handlers.
   */
  cleanup() {
    if (this._cleanupFn) {
      this._cleanupFn();
      this._cleanupFn = null;
    }
  }
}

export default BaseWebviewMessageHandler;
