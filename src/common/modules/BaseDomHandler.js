// Local imports - common
// None

/**
 * Base class for DOM handlers.
 * Stores manager instances and cleans up event listeners and managers.
 */
export class BaseDomHandler {
  constructor(managers = {}) {
    this._listeners = [];
    this._managers = managers;
    Object.assign(this, managers);
  }

  /**
   * Register an event handler and store it for later cleanup.
   * @param {HTMLElement|string} elementOrId - Element or its ID
   * @param {string} event - Event type
   * @param {EventListenerOrEventListenerObject} handler - Handler function
   */
  addListener(elementOrId, event, handler) {
    const element =
      typeof elementOrId === 'string'
        ? document.getElementById(elementOrId)
        : elementOrId;
    if (element) {
      element.addEventListener(event, handler);
      this._listeners.push({ element, event, handler });
    }
  }

  /**
   * Remove all registered listeners and call cleanup on managers.
   */
  cleanup() {
    this._listeners.forEach(({ element, event, handler }) => {
      element.removeEventListener(event, handler);
    });
    this._listeners = [];

    Object.values(this._managers).forEach((mgr) => {
      if (mgr && typeof mgr.cleanup === 'function') {
        mgr.cleanup();
      }
    });
  }
}
