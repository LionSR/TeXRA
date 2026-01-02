// Local imports - profile view
import { ELEMENT_IDS } from '../constants.js';
import { PROFILE_VIEW_COMMANDS } from '@common/webview/commands.js';
import { vscode } from '@common/webviewContext.js';
import {
  safeGetElementById,
  addEventListenerSafely,
} from '@common/domUtils.js';

/**
 * Manages event listeners for the profile view.
 */
export class ProfileEventsManager {
  constructor(agentsTable) {
    this.agentsTable = agentsTable;
    this._listeners = [];
  }

  /**
   * Set up event listeners.
   */
  setup() {
    // Sign in button click handler
    const signInBtn = safeGetElementById(ELEMENT_IDS.SIGN_IN_BTN);
    if (signInBtn) {
      const signInHandler = () => {
        vscode.postMessage({ command: PROFILE_VIEW_COMMANDS.SIGN_IN });
      };
      const cleanup = addEventListenerSafely(signInBtn, 'click', signInHandler);
      if (cleanup) {
        this._listeners.push(cleanup);
      }
    }
  }

  /**
   * Clean up event listeners.
   */
  dispose() {
    this._listeners.forEach((cleanup) => {
      if (typeof cleanup === 'function') {
        cleanup();
      }
    });
    this._listeners = [];
  }
}
