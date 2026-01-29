import { z } from 'zod';

/**
 * Minimal storage interface for state persistence.
 * Works with both backend (Memento) and frontend (webview) storage.
 */
export interface StateStorage {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

/**
 * Create storage adapter for backend (vscode.Memento wrapper).
 *
 * @example
 * import { workspaceSM } from '@common/state';
 * const storage = createBackendStorage(workspaceSM);
 */
export function createBackendStorage(memento: {
  get(key: string): unknown;
  update(key: string, value: unknown): Thenable<void>;
}): StateStorage {
  return {
    get: (key) => memento.get(key),
    set: (key, value) => void memento.update(key, value),
  };
}

/**
 * Create storage adapter for webview (vscode.getState/setState).
 * All keys share a single state object.
 *
 * Caches state in memory to avoid repeated getState() calls on rapid updates.
 *
 * @example
 * import { vscode } from '@shared/vscode';
 * const storage = createWebviewStorage(vscode);
 */
export function createWebviewStorage(vscode: {
  getState(): unknown;
  setState(state: unknown): void;
}): StateStorage {
  // Cache full state - read once, update in memory
  let cache = (vscode.getState() as Record<string, unknown>) ?? {};

  return {
    get: (key) => cache[key],
    set: (key, value) => {
      cache = { ...cache, [key]: value };
      vscode.setState(cache);
    },
  };
}

/**
 * Unified state persistence with Zod schema validation.
 *
 * Works identically for both backend and frontend - only the storage differs:
 * - Backend: `createBackendStorage(workspaceSM)` → workspace-scoped, persists across sessions
 * - Frontend: `createWebviewStorage(vscode)` → webview-scoped, transient UI state
 *
 * The schema MUST use .catch() for all fields to provide fallback values.
 *
 * @example
 * // Backend (user preferences - persist across sessions)
 * const prefs = new PersistedState(
 *   createBackendStorage(workspaceSM),
 *   WorkspaceStateKey.VIEW_PREFS,
 *   z.object({ filter: z.string().catch('all') }),
 * );
 *
 * @example
 * // Frontend (UI state - transient, fast)
 * const ui = new PersistedState(
 *   createWebviewStorage(vscode),
 *   'toggleStates',
 *   z.object({ expanded: z.array(z.string()).catch([]) }),
 * );
 *
 * @example
 * // Both use identical API
 * prefs.get('filter');        // Get single field
 * prefs.getState();           // Get all state
 * prefs.update({ filter: 'active' }); // Partial update
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
    return this.schema.parse(this.storage.get(this.key));
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
    this.storage.set(this.key, this.state);
  }

  /** Partial update (merge) */
  update(partial: Partial<T>): void {
    this.setState({ ...this.state, ...partial });
  }

  /** Reset to schema defaults */
  reset(): void {
    this.state = this.schema.parse(undefined);
    this.storage.set(this.key, this.state);
  }

  /** Reload from storage */
  reload(): void {
    this.state = this.load();
  }
}
