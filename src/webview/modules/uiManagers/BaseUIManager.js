// Local imports - webview
import { safeGetElementById } from '@common/domUtils.js';

export class BaseUIManager {
  constructor() {
    this._listeners = [];
  }

  /**
   * Register an event handler and store the listener for cleanup.
   * @param {HTMLElement|string} elementOrId - element or its ID
   * @param {string} event - event type
   * @param {EventListenerOrEventListenerObject} handler - handler function
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
   * @param {HTMLElement|string} elementOrId - element or its ID
   * @param {string} event - event type
   * @param {EventListenerOrEventListenerObject} handler - handler function
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
   * Remove all registered event listeners.
   */
  cleanup() {
    this._listeners.forEach(({ element, event, handler }) => {
      element.removeEventListener(event, handler);
    });
    this._listeners = [];
  }
}
