// Toggle state management - single source of truth for collapsible state storage
// Used across progressView, historyView, and other modules

/**
 * Manages toggle/collapse states with optional persistence callback.
 * Provides a unified API for storing and retrieving boolean toggle states.
 */
export class ToggleStateStore {
  /**
   * @param {Function} [saveCallback] - Optional callback invoked after state changes
   */
  constructor(saveCallback) {
    this._states = new Map();
    this._saveCallback = saveCallback;
  }

  /**
   * Set the toggle state for an ID.
   * @param {string} id - The identifier
   * @param {boolean} value - The toggle state
   */
  set(id, value) {
    if (!id) return;
    this._states.set(id, value);
    this._saveCallback?.();
  }

  /**
   * Get the toggle state for an ID.
   * @param {string} id - The identifier
   * @returns {boolean|undefined} The toggle state, or undefined if not set
   */
  get(id) {
    return this._states.get(id);
  }

  /**
   * Clear specific toggle states by ID.
   * @param {string[]} ids - Array of identifiers to clear
   */
  clearSelection(ids) {
    if (!Array.isArray(ids)) return;
    ids.forEach((id) => {
      if (id) this._states.delete(id);
    });
    this._saveCallback?.();
  }

  /**
   * Clear all toggle states.
   */
  clearAll() {
    this._states.clear();
    this._saveCallback?.();
  }

  /**
   * Get all entries for serialization as [key, value] pairs.
   * @returns {Array<[string, boolean]>} Array of [id, state] pairs
   */
  entries() {
    return [...this._states.entries()];
  }

  /**
   * Load state from serialized array data (e.g., from entries()).
   * @param {Array<[string, boolean]>} data - Array of [id, state] pairs
   */
  load(data) {
    if (Array.isArray(data)) {
      this._states = new Map(data);
    }
  }
}
