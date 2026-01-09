// Local imports - common

/**
 * Bootstrap a webview with consistent lifecycle hooks.
 * @param {Object} options
 * @param {Function} [options.initializeState]
 * @param {Function} [options.setupHandlers]
 * @param {Function} [options.onDomReady]
 * @param {Function} [options.onDispose]
 */
export function bootstrapWebview({
  initializeState,
  setupHandlers,
  onDomReady,
  onDispose,
} = {}) {
  if (initializeState) {
    initializeState();
  }

  if (setupHandlers) {
    setupHandlers();
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (onDomReady) {
      onDomReady();
    }
  });

  window.addEventListener('beforeunload', () => {
    if (onDispose) {
      onDispose();
    }
  });
}
