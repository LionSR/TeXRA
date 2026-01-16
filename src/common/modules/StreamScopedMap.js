/**
 * A Map wrapper that stores values keyed by stream ID.
 * Provides consistent get/set/clear/clearAll methods with stream ID resolution.
 *
 * @template T The type of values stored in the map
 */
export class StreamScopedMap {
  /**
   * @param {(streamId: string | null | undefined) => string | null} resolveStreamId
   *   Function to resolve/normalize stream IDs (e.g., fallback to active stream)
   */
  constructor(resolveStreamId) {
    this._resolveStreamId = resolveStreamId;
    this._data = new Map();
  }

  /**
   * Set a value for a stream.
   * @param {string} streamId - The stream ID
   * @param {T} value - The value to store
   */
  set(streamId, value) {
    const targetStream = this._resolveStreamId(streamId);
    if (targetStream == null) {
      return;
    }
    this._data.set(targetStream, value);
  }

  /**
   * Get the value for a stream.
   * @param {string} streamId - The stream ID
   * @returns {T | undefined} The stored value or undefined
   */
  get(streamId) {
    const targetStream = this._resolveStreamId(streamId);
    if (targetStream == null) {
      return undefined;
    }
    return this._data.get(targetStream);
  }

  /**
   * Check if a value exists for a stream.
   * @param {string} streamId - The stream ID
   * @returns {boolean} True if a value exists
   */
  has(streamId) {
    const targetStream = this._resolveStreamId(streamId);
    if (targetStream == null) {
      return false;
    }
    return this._data.has(targetStream);
  }

  /**
   * Delete the value for a specific stream.
   * @param {string} streamId - The stream ID
   */
  delete(streamId) {
    const targetStream = this._resolveStreamId(streamId);
    if (targetStream == null) {
      return;
    }
    this._data.delete(targetStream);
  }

  /**
   * Clear all stored values.
   */
  clear() {
    this._data.clear();
  }

  /**
   * Clear a specific stream's value or all values.
   * Convenience method for the common pattern: clear one stream or clear all.
   * @param {string|null|undefined} streamId - Stream to clear, or null/undefined to clear all
   */
  clearStreamOrAll(streamId) {
    if (streamId == null) {
      this._data.clear();
    } else {
      this.delete(streamId);
    }
  }

  /**
   * Get the number of stored entries.
   * @returns {number}
   */
  get size() {
    return this._data.size;
  }

  /**
   * Iterate over all entries.
   * @returns {IterableIterator<[string, T]>}
   */
  entries() {
    return this._data.entries();
  }

  /**
   * Iterate over all keys.
   * @returns {IterableIterator<string>}
   */
  keys() {
    return this._data.keys();
  }

  /**
   * Iterate over all values.
   * @returns {IterableIterator<T>}
   */
  values() {
    return this._data.values();
  }
}
