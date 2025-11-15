// Local imports - common
import { registerMessageHandlers } from './webviewContext.js';
import { createMessageHandlerRegistry } from './messageHandlerRegistry.js';

/**
 * Base class for webview message handlers.
 * Provides default setup and cleanup logic for registering
 * message handlers with the VS Code webview context.
 *
 * @abstract
 * @example
 * class MyHandler extends BaseWebviewMessageHandler {
 *   constructor() {
 *     super();
 *     // Populate handlers before calling setup()
 *     this._handlers = {
 *       'MY_COMMAND': (message) => { ... }
 *     };
 *   }
 * }
 */
export class BaseWebviewMessageHandler {
  constructor() {
    /**
     * Map of command names to handler functions.
     * Derived classes must populate this before calling setup().
     * @type {Object.<string, Function>}
     * @protected
     */
    this._handlers = {};

    /**
     * Shared handler registry used to coordinate setup/cleanup.
     * @type {ReturnType<typeof createMessageHandlerRegistry>}
     * @protected
     */
    this._registry = createMessageHandlerRegistry(this._handlers);
  }

  /**
   * Register message handlers with the webview and store the cleanup function.
   * Validates that handlers are defined before registration.
   * @throws {Error} If handlers are not properly defined
   */
  setup() {
    if (!this._handlers || typeof this._handlers !== 'object') {
      throw new Error('BaseWebviewMessageHandler: handlers must be an object');
    }

    if (Object.keys(this._handlers).length === 0) {
      console.warn(
        'BaseWebviewMessageHandler: No handlers defined for registration',
      );
    }

    this._registry.setHandlers(this._handlers);
    this._registry.register((handlers) => registerMessageHandlers(handlers));
  }

  /**
   * Remove previously registered message handlers.
   * Calls the stored cleanup function and resets internal state.
   * Safe to call multiple times.
   */
  cleanup() {
    this._registry.dispose();
  }
}

export default BaseWebviewMessageHandler;
