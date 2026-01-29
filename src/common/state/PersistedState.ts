import { z } from 'zod';

/**
 * Generic storage interface that works for both:
 * - Backend: vscode.Memento (workspace/global state)
 * - Frontend: vscode.getState()/setState() (webview state)
 */
export interface StateStorage {
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): void | Thenable<void>;
}

/**
 * Single-key storage adapter for webview state (vscode.getState/setState).
 * Stores all state under one key since webview state is already scoped.
 */
export interface SingleKeyStorage {
  getState(): unknown;
  setState(value: unknown): void;
}

/**
 * Adapts SingleKeyStorage (webview) to StateStorage interface.
 * All keys share the same underlying state object.
 */
export function createWebviewStorageAdapter(
  storage: SingleKeyStorage,
): StateStorage {
  return {
    get<T>(key: string, defaultValue?: T): T | undefined {
      const state = (storage.getState() as Record<string, unknown>) ?? {};
      const value = state[key];
      return value !== undefined ? (value as T) : defaultValue;
    },
    update(key: string, value: unknown): void {
      const state = (storage.getState() as Record<string, unknown>) ?? {};
      storage.setState({ ...state, [key]: value });
    },
  };
}

/**
 * Manages persistence of a typed state object with Zod schema validation.
 *
 * Works with both backend (vscode.Memento) and frontend (vscode.getState/setState)
 * storage through the common StateStorage interface.
 *
 * Features:
 * - Zod schema validation on load with `.catch()` for defaults
 * - Type-safe get/set/update operations
 * - Supports legacy format migration via union schemas
 *
 * @example
 * // Backend usage (workspace state)
 * const prefs = new PersistedState(
 *   workspaceSM,
 *   'texra.viewPrefs',
 *   z.object({
 *     sortOrder: z.string().catch('time'),
 *     filter: z.string().catch('all'),
 *   }),
 * );
 *
 * @example
 * // Frontend usage (webview state)
 * const state = new PersistedState(
 *   createWebviewStorageAdapter(vscode),
 *   'prefs',
 *   PrefsSchema,
 * );
 *
 * @example
 * // Legacy format migration with union schema
 * const LegacySchema = z.object({ old: z.string() })
 *   .transform((v) => ({ new: v.old }));
 * const CurrentSchema = z.object({ new: z.string() });
 * const MigratingSchema = z.union([CurrentSchema, LegacySchema]);
 */
export class PersistedState<T extends Record<string, unknown>> {
  private state: T;

  constructor(
    private readonly storage: StateStorage,
    private readonly key: string,
    private readonly schema: z.ZodType<T>,
  ) {
    this.state = this.load();
  }

  private load(): T {
    const saved = this.storage.get(this.key);
    return this.schema.parse(saved);
  }

  /** Get current state (shallow copy) */
  getState(): T {
    return { ...this.state };
  }

  /** Get a single field */
  get<K extends keyof T>(field: K): T[K] {
    return this.state[field];
  }

  /** Replace entire state */
  setState(state: T): void {
    this.state = { ...state };
    void this.storage.update(this.key, this.state);
  }

  /** Partial update (merge) */
  update(partial: Partial<T>): void {
    this.setState({ ...this.state, ...partial });
  }

  /** Reset to schema defaults (by parsing undefined) */
  reset(): void {
    this.state = this.schema.parse(undefined);
    void this.storage.update(this.key, this.state);
  }

  /** Reload from storage (useful after external changes) */
  reload(): void {
    this.state = this.load();
  }
}
