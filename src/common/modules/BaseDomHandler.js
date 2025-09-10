// Local imports - common
import { safeGetElementById } from './domUtils.js';

/**
 * Base class for DOM handlers across views.
 * Stores manager references and provides unified cleanup.
 */
export class BaseDomHandler {
  /**
   * @param {Record<string, any>} managers - mapping of manager names to instances
   */
  constructor(managers = {}) {
    this._listeners = [];
    this._managers = managers;
    Object.assign(this, managers);
  }

  /**
   * Register an event handler and store it for cleanup.
   * @param {HTMLElement|string} elementOrId - element or its ID
   * @param {string} event - event type
   * @param {EventListenerOrEventListenerObject} handler - event handler
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
   * Remove all registered event listeners and cleanup managers.
   */
  cleanup() {
    this._listeners.forEach(({ element, event, handler }) => {
      element.removeEventListener(event, handler);
    });
    this._listeners = [];

    Object.values(this._managers).forEach((manager) => {
      if (manager && typeof manager.cleanup === 'function') {
        manager.cleanup();
      }
    });
  }
}
