/**
 * Shared registry for managing webview message handlers across environments.
 * Stores the handler map, registers it with a provided hook, and exposes
 * a cleanup method for disposing registrations.
 */
export function createMessageHandlerRegistry(initialHandlers = {}) {
  let handlers = initialHandlers;
  let cleanup = null;

  const assertHandlers = (candidate) => {
    if (!candidate || typeof candidate !== 'object') {
      throw new Error('Message handler registry requires an object map');
    }
  };

  return {
    getHandlers() {
      return handlers;
    },
    setHandlers(nextHandlers) {
      assertHandlers(nextHandlers);
      handlers = nextHandlers;
    },
    register(registerFn) {
      assertHandlers(handlers);
      if (cleanup) {
        cleanup();
        cleanup = null;
      }

      const result = registerFn(handlers);
      if (typeof result === 'function') {
        cleanup = result;
      }
      return cleanup;
    },
    dispose() {
      if (cleanup) {
        cleanup();
        cleanup = null;
      }
    },
  };
}
