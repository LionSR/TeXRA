/**
 * Manages toggle/collapse states with optional persistence callback.
 * Provides a unified API for storing and retrieving boolean toggle states.
 */
export class ToggleStateStore {
  private _states: Map<string, boolean>;
  private _saveCallback?: () => void;

  constructor(saveCallback?: () => void) {
    this._states = new Map();
    this._saveCallback = saveCallback;
  }

  /**
   * Set the toggle state for an ID.
   */
  set(id: string, value: boolean): void {
    if (!id) return;
    this._states.set(id, value);
    this._saveCallback?.();
  }

  /**
   * Get the toggle state for an ID.
   */
  get(id: string): boolean | undefined {
    return this._states.get(id);
  }

  /**
   * Clear specific toggle states by ID.
   */
  clearSelection(ids: string[]): void {
    if (!Array.isArray(ids)) return;
    for (const id of ids) {
      if (id) this._states.delete(id);
    }
    this._saveCallback?.();
  }

  /**
   * Clear all toggle states.
   */
  clearAll(): void {
    this._states.clear();
    this._saveCallback?.();
  }

  /**
   * Get all entries for serialization as [key, value] pairs.
   */
  entries(): Array<[string, boolean]> {
    return [...this._states.entries()];
  }

  /**
   * Load state from serialized array data (e.g., from entries()).
   */
  load(data: Array<[string, boolean]>): void {
    if (Array.isArray(data)) {
      this._states = new Map(data);
    }
  }
}
