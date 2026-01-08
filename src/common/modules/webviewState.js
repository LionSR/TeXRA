// Local imports - common
import { vscode } from '@common/webviewContext.js';

/**
 * Manages persistence of state for a single webview.
 * Wraps the VS Code `getState` and `setState` APIs.
 */
export class WebviewStateManager {
  /**
   * @param {Record<string, any>} [defaultState] optional defaults used when no
   * previous state exists.
   */
  constructor(defaultState = {}) {
    this.defaultState = { ...defaultState };
    try {
      const saved = vscode.getState() ?? {};
      this.state = { ...this.defaultState, ...saved };
    } catch (e) {
      console.error('Failed to get state:', e);
      this.state = { ...this.defaultState };
    }
  }

  /**
   * Returns a copy of the current state object.
   */
  getState() {
    return { ...this.state };
  }

  /**
   * Replaces the entire state and persists it via VS Code API.
   * @param {Record<string, any>} state new state
   */
  setState(state) {
    this.state = { ...state };
    try {
      vscode.setState(this.state);
    } catch (e) {
      console.error('Failed to set state:', e);
    }
  }

  /**
   * Applies partial updates to the state and persists the result.
   * @param {Record<string, any>} partial partial state to merge
   */
  update(partial) {
    this.setState({ ...this.state, ...partial });
  }

  /**
   * Resets state back to the provided defaults.
   */
  reset() {
    this.setState({ ...this.defaultState });
  }
}
