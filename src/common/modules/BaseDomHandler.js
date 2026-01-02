// Local imports - common
import { safeGetElementById } from './domUtils.js';

/**
 * Base class for DOM handlers and UI managers.
 * Stores manager instances and disposes event listeners and managers.
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
        ? safeGetElementById(elementOrId)
        : elementOrId;
    if (element) {
      element.addEventListener(event, handler);
      this._listeners.push({ element, event, handler });
    }
  }

  /**
   * Remove a previously registered event handler and stop tracking it.
   * @param {HTMLElement|string} elementOrId - Element or its ID
   * @param {string} event - Event type
   * @param {EventListenerOrEventListenerObject} handler - Handler function
   */
  removeListener(elementOrId, event, handler) {
    const element =
      typeof elementOrId === 'string'
        ? safeGetElementById(elementOrId)
        : elementOrId;
    if (!element) {
      return;
    }

    element.removeEventListener(event, handler);
    this._listeners = this._listeners.filter(
      (listener) =>
        listener.element !== element ||
        listener.event !== event ||
        listener.handler !== handler,
    );
  }

  /**
   * Remove all registered listeners and dispose managers.
   */
  dispose() {
    this._listeners.forEach(({ element, event, handler }) => {
      element.removeEventListener(event, handler);
    });
    this._listeners = [];

    Object.values(this._managers).forEach((mgr) => {
      if (mgr && typeof mgr.dispose === 'function') {
        mgr.dispose();
      }
    });
  }
}
