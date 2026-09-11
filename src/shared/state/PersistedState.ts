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
 * Renderer UI state persisted under one key of a `StateStore`, validated by a
 * Zod schema. Two renderers use it: the Progress-View surfaces over
 * `createWebviewStorage(hostBridge)`, and the desktop shell's collapsed-group
 * set over localStorage.
 *
 * Every schema field must carry a `.prefault()` — the constructor resolves
 * defaults with `schema.parse({})` and throws when they are incomplete. Never
 * `.catch()`, which would swallow invalid stored data before the loud
 * warn-and-reset path can see it.
 *
 * @example
 * const ui = new PersistedState(
 *   createWebviewStorage(hostBridge),
 *   'toggleStates',
 *   z.object({ expanded: z.array(z.string()).prefault([]) }),
 * );
 * ui.setState({ expanded: [...ui.getState().expanded, id] });
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
      return this.schema.parse({});
    }
    const result = this.schema.safeParse(stored);
    if (result.success) {
      return result.data;
    }
    // Reset invalid stored data to the schema defaults — a stale or malformed
    // key must never block renderer startup — and persist the reset so the
    // next load doesn't keep hitting this path. The schema itself must default
    // every field: `parse({})` throws at construction when it doesn't.
    console.warn(
      `[PersistedState] Invalid stored data for ${this.key}, resetting.`,
      {
        storedType: describeStored(stored),
        issues: summarizeIssues(result.error),
      },
    );
    const defaults = this.schema.parse({});
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

  /** Get current state (shallow copy) */
  getState(): T {
    return { ...this.state };
  }

  /** Replace entire state */
  setState(state: T): void {
    this.state = { ...state };
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
