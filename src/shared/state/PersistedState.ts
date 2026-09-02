import { z } from 'zod';

import type { StateStore } from '@platform/interfaces';

/**
 * Create a {@link StateStore} over webview host state. All keys share a single
 * state object, cached in memory to avoid repeated getState() calls on rapid
 * updates.
 *
 * A key is removed by updating it to `undefined`, as with a Memento. `update`
 * returns an already-resolved promise because `setState` is synchronous and
 * cannot fail — that is not a dropped write.
 *
 * @example
 * import { hostBridge } from '@shared/hostBridge';
 * const storage = createWebviewStorage(hostBridge);
 */
export function createWebviewStorage(hostBridge: {
  getState(): unknown;
  setState(state: unknown): void;
}): StateStore {
  // Cache full state - read once, update in memory
  const cache = (hostBridge.getState() as Record<string, unknown>) ?? {};

  return {
    get<T>(key: string, defaultValue?: T): T {
      const value = cache[key];
      return value === undefined ? (defaultValue as T) : (value as T);
    },
    update(key, value) {
      if (value === undefined) {
        delete cache[key];
      } else {
        cache[key] = value;
      }
      hostBridge.setState(cache);
      return Promise.resolve();
    },
  };
}

/**
 * Unified state persistence with Zod schema validation.
 *
 * Takes the platform `StateStore` port directly; only the implementation differs:
 * - Backend: the host's own store → workspace-scoped, persists across sessions
 * - Frontend: `createWebviewStorage(hostBridge)` → webview-scoped, transient UI state
 *
 * Schemas should use .prefault() for fields to provide defaults — never
 * .catch(), which would swallow invalid stored data before this class's loud
 * warn-and-reset path can see it. If storage returns undefined or invalid
 * data, falls back to schema defaults.
 *
 * @example
 * // Backend (user preferences - persist across sessions)
 * const prefs = new PersistedState(
 *   platform().workspaceState,
 *   WorkspaceStateKey.VIEW_PREFS,
 *   z.object({ filter: z.string().prefault('all') }),
 * );
 *
 * @example
 * // Frontend (UI state - transient, fast)
 * const ui = new PersistedState(
 *   createWebviewStorage(hostBridge),
 *   'toggleStates',
 *   z.object({ expanded: z.array(z.string()).prefault([]) }),
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
    private readonly storage: StateStore,
    private readonly key: string,
    private readonly schema: z.ZodType<T>,
  ) {
    this.state = this.load();
  }

  private load(): T {
    const stored = this.storage.get(this.key);
    if (stored === undefined) {
      return this.resolveDefaults();
    }
    const result = this.schema.safeParse(stored);
    if (result.success) {
      return result.data;
    }
    // Fall back to schema defaults so a schema whose defaults don't cover every
    // field can't throw out of a caller's constructor — a stale or malformed
    // PersistedState key must never block webview activation or extension
    // startup. Also persist the reset so the bad value is replaced and the next
    // load doesn't keep hitting this path.
    console.warn(
      `[PersistedState] Invalid stored data for ${this.key}, resetting.`,
      {
        storedType: describeStored(stored),
        issues: summarizeIssues(result.error),
      },
    );
    const defaults = this.resolveDefaults();
    this.persist(defaults);
    return defaults;
  }

  /**
   * Write through to storage. The promise is deliberately not awaited — every
   * caller is a synchronous UI path — but a rejection must not escape as an
   * unhandled rejection, which on the desktop main process is an uncaught
   * error with no attribution to the failing key. Warn loudly instead.
   */
  private persist(value: T): void {
    void Promise.resolve(this.storage.update(this.key, value)).catch(
      (error: unknown) => {
        console.warn(
          `[PersistedState] Failed to persist ${this.key}; the in-memory value is now ahead of storage.`,
          error,
        );
      },
    );
  }

  /**
   * Resolve the schema's default state by parsing an empty object. Returns the
   * parsed defaults, or an empty object (with a warning) when the schema's
   * defaults don't cover every field.
   */
  private resolveDefaults(): T {
    const defaultResult = this.schema.safeParse({});
    if (defaultResult.success) {
      return defaultResult.data;
    }
    console.warn(
      `[PersistedState] No schema defaults for ${this.key}; using empty object.`,
      { issues: summarizeIssues(defaultResult.error) },
    );
    return {} as T;
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
    this.persist(this.state);
  }

  /** Reload current state from the backing storage. */
  reload(): void {
    this.state = this.load();
  }

  /** Partial update (merge) */
  update(partial: Partial<T>): void {
    this.setState({ ...this.state, ...partial });
  }

  /** Reset to schema defaults */
  reset(): void {
    this.state = this.resolveDefaults();
    this.persist(this.state);
  }
}

/**
 * Produce a compact, log-safe description of a stored value. Tiny fingerprint
 * so we can tell "undefined" from "object with these keys" from "string of
 * length N" without dumping user data into the console.
 */
function describeStored(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `array(len=${value.length})`;
  const type = typeof value;
  if (type === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    const preview = keys.slice(0, 6).join(',');
    const suffix = keys.length > 6 ? `,+${keys.length - 6}` : '';
    return `object{${preview}${suffix}}`;
  }
  if (type === 'string') return `string(len=${(value as string).length})`;
  return type;
}

/** First few zod issues, trimmed so the console stays readable. */
function summarizeIssues(error: z.ZodError): Record<string, unknown>[] {
  return error.issues.slice(0, 5).map((issue) => ({
    path: issue.path.join('.') || '(root)',
    code: issue.code,
    message: issue.message,
  }));
}
