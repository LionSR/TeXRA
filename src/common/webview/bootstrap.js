/* eslint-env browser */

/**
 * Bootstraps a webview by initializing state objects, wiring up message
 * handlers and registering lifecycle callbacks.
 *
 * @param {Object} options configuration options
 * @param {Array<Object>} [options.state=[]] objects with optional `initialize`
 * and `restore` methods
 * @param {{setup: Function, cleanup: Function}} options.messageHandler message
 * handler with setup/cleanup methods
 * @param {Function} [options.onDomContentLoaded] callback after DOM is ready
 * @param {Function} [options.onBeforeUnload] callback before the view unloads
 */
export function bootstrap({
  state = [],
  messageHandler,
  onDomContentLoaded,
  onBeforeUnload,
} = {}) {
  // Initialize state objects immediately if they provide an initialize method
  state.forEach((s) => {
    if (typeof s.initialize === 'function') {
      s.initialize();
    }
  });

  // Set up message handler early so initial messages are not missed
  if (messageHandler && typeof messageHandler.setup === 'function') {
    messageHandler.setup();
  }

  window.addEventListener('beforeunload', () => {
    if (messageHandler && typeof messageHandler.cleanup === 'function') {
      messageHandler.cleanup();
    }
    if (typeof onBeforeUnload === 'function') {
      onBeforeUnload();
    }
  });

  document.addEventListener('DOMContentLoaded', () => {
    // Restore state once DOM is ready
    state.forEach((s) => {
      if (typeof s.restore === 'function') {
        s.restore();
      }
    });

    if (typeof onDomContentLoaded === 'function') {
      onDomContentLoaded();
    }
  });
}
