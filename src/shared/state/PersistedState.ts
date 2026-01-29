import { z } from 'zod';

/**
 * Storage interface that works for both:
 * - Backend: vscode.Memento (via StateStorage wrapper)
 * - Frontend: vscode.getState/setState (via WebviewStorage adapter)
 */
export interface Storage {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

/**
 * Adapter for webview storage (vscode.getState/setState).
 * Stores all keys in a single state object.
 */
export function createWebviewStorage(vscode: {
  getState(): unknown;
  setState(state: unknown): void;
}): Storage {
  return {
    get(key: string): unknown {
      const state = (vscode.getState() as Record<string, unknown>) ?? {};
      return state[key];
    },
    set(key: string, value: unknown): void {
      const state = (vscode.getState() as Record<string, unknown>) ?? {};
      vscode.setState({ ...state, [key]: value });
    },
  };
}

/**
 * Adapter for workspace/global storage (vscode.Memento).
 */
export function createMementoStorage(memento: {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}): Storage {
  return {
    get(key: string): unknown {
      return memento.get(key);
    },
    set(key: string, value: unknown): void {
      void memento.update(key, value);
    },
  };
}

/**
 * Unified state persistence with Zod schema validation.
 *
 * Works for both frontend (webview) and backend (extension host) by
 * accepting a Storage interface. Use the adapters above to create
 * the appropriate storage for your context.
 *
 * The schema MUST use .catch() or .default() for all fields to provide
 * fallback values when storage is empty or contains invalid data.
 *
 * @example
 * // Frontend (webview)
 * import { vscode } from '@shared/vscode';
 *
 * const PrefsSchema = z.object({
 *   filter: z.string().catch('all'),
 *   sort: z.string().catch('time'),
 * });
 *
 * const prefs = new PersistedState(
 *   createWebviewStorage(vscode),
 *   'prefs',
 *   PrefsSchema,
 * );
 *
 * @example
 * // Backend (extension host)
 * import { workspaceSM } from '@common/state';
 *
 * const prefs = new PersistedState(
 *   createMementoStorage(workspaceSM),
 *   WorkspaceStateKey.VIEW_PREFS,
 *   PrefsSchema,
 * );
 */
export class PersistedState<T extends Record<string, unknown>> {
  private state: T;

  constructor(
    private readonly storage: Storage,
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
