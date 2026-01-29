// @ts-check
import { vscode } from '@common/webviewContext.js';

/**
 * @template T
 * @typedef {import('zod').ZodType<T>} ZodType
 */

/**
 * Manages persistence of a typed state object with Zod schema validation.
 *
 * Works with vscode.getState/setState for webview state persistence.
 * Uses Zod schemas for validation and default values via `.catch()`.
 *
 * @template {Record<string, unknown>} T
 *
 * @example
 * import { z } from 'zod';
 *
 * const PrefsSchema = z.object({
 *   filter: z.string().catch('all'),
 *   sort: z.string().catch('time'),
 * });
 *
 * const prefs = new PersistedState('prefs', PrefsSchema);
 * console.log(prefs.get('filter')); // 'all' (default)
 * prefs.update({ filter: 'active' });
 */
export class PersistedState {
  /** @type {T} */
  #state;

  /** @type {string} */
  #key;

  /** @type {ZodType<T>} */
  #schema;

  /**
   * @param {string} key - Storage key for this state
   * @param {ZodType<T>} schema - Zod schema with .catch() for defaults
   */
  constructor(key, schema) {
    this.#key = key;
    this.#schema = schema;
    this.#state = this.#load();
  }

  /**
   * Load state from storage with schema validation.
   * @returns {T}
   */
  #load() {
    const allState = vscode.getState() || {};
    const saved = allState[this.#key];
    return this.#schema.parse(saved);
  }

  /**
   * Save state to storage.
   */
  #save() {
    const allState = vscode.getState() || {};
    vscode.setState({ ...allState, [this.#key]: this.#state });
  }

  /**
   * Get current state (shallow copy).
   * @returns {T}
   */
  getState() {
    return { ...this.#state };
  }

  /**
   * Get a single field.
   * @template {keyof T} K
   * @param {K} field
   * @returns {T[K]}
   */
  get(field) {
    return this.#state[field];
  }

  /**
   * Replace entire state.
   * @param {T} state
   */
  setState(state) {
    this.#state = { ...state };
    this.#save();
  }

  /**
   * Partial update (merge).
   * @param {Partial<T>} partial
   */
  update(partial) {
    this.setState({ ...this.#state, ...partial });
  }

  /**
   * Reset to schema defaults (by parsing undefined).
   */
  reset() {
    this.#state = this.#schema.parse(undefined);
    this.#save();
  }

  /**
   * Reload from storage (useful after external changes).
   */
  reload() {
    this.#state = this.#load();
  }
}
