// Local imports
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
   * @param {boolean|AddEventListenerOptions} [options] - optional listener options
   */
  addListener(elementOrId, event, handler, options) {
    const element =
      typeof elementOrId === 'string'
        ? safeGetElementById(elementOrId)
        : elementOrId;
    if (element) {
      element.addEventListener(event, handler, options);
      this._listeners.push({ element, event, handler, options });
    }
  }

  /**
   * Remove all registered event listeners.
   */
  cleanup() {
    this._listeners.forEach(({ element, event, handler, options }) => {
      element.removeEventListener(event, handler, options);
    });
    this._listeners = [];
  }
}
