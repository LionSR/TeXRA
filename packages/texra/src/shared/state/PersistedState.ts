import { Result, Schema, SchemaIssue } from 'effect';

/** A renderer's synchronous key-value store; `undefined` removes a key. */
export interface KeyValueStore {
  get<T>(key: string, defaultValue?: T): T;
  update(key: string, value: unknown): void;
}

/**
 * Create a {@link KeyValueStore} over webview host state. All keys share a
 * single state object, cached in memory to avoid repeated getState() calls on
 * rapid updates.
 *
 * @example
 * import { hostBridge } from '@texra/shared/hostBridge';
 * const storage = createWebviewStorage(hostBridge);
 */
export function createWebviewStorage(hostBridge: {
  getState(): unknown;
  setState(state: unknown): void;
}): KeyValueStore {
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
    },
  };
}

/**
 * Renderer UI state persisted under one key of a `KeyValueStore`, validated by a
 * schema. Two renderers use it: the Progress-View surfaces over
 * `createWebviewStorage(hostBridge)`, and the desktop shell's collapsed-group
 * set over localStorage.
 *
 * The schema must decode `{}` into complete state (a decoding default on each
 * required field): the constructor resolves defaults by decoding `{}` and
 * throws otherwise. Never `catchDecoding`, which would swallow invalid stored
 * data before the loud warn-and-reset path can see it.
 *
 * @example
 * const ui = new PersistedState(
 *   createWebviewStorage(hostBridge),
 *   'toggleStates',
 *   Schema.Struct({
 *     expanded: Schema.Array(Schema.String).pipe(
 *       Schema.withDecodingDefault(Effect.succeed([])),
 *     ),
 *   }),
 * );
 * ui.setState({ expanded: [...ui.getState().expanded, id] });
 */
export class PersistedState<T extends Record<string, unknown>> {
  private state: T;

  constructor(
    private readonly storage: KeyValueStore,
    private readonly key: string,
    private readonly schema: Schema.Codec<T, unknown>,
  ) {
    this.state = this.load();
  }

  private load(): T {
    const stored = this.storage.get(this.key);
    if (stored === undefined) {
      return Schema.decodeUnknownSync(this.schema)({});
    }
    const result = Schema.decodeUnknownResult(this.schema)(stored);
    if (Result.isSuccess(result)) {
      return result.success;
    }
    // Reset invalid stored data to the schema defaults — a stale or malformed
    // key must never block renderer startup — and persist the reset so the
    // next load doesn't keep hitting this path. The schema itself must default
    // every field: decoding `{}` throws at construction when it doesn't.
    console.warn(
      `[PersistedState] Invalid stored data for ${this.key}, resetting.`,
      {
        storedType: describeStored(stored),
        issues: summarizeIssues(result.failure),
      },
    );
    const defaults = Schema.decodeUnknownSync(this.schema)({});
    this.storage.update(this.key, defaults);
    return defaults;
  }

  /** Get current state (shallow copy) */
  getState(): T {
    return { ...this.state };
  }

  /** Replace entire state */
  setState(state: T): void {
    this.state = { ...state };
    this.storage.update(this.key, this.state);
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
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    const preview = keys.slice(0, 6).join(',');
    const suffix = keys.length > 6 ? `,+${keys.length - 6}` : '';
    return `object{${preview}${suffix}}`;
  }
  if (typeof value === 'string') return `string(len=${value.length})`;
  return typeof value;
}

/** First few schema issues, trimmed so the console stays readable. */
function summarizeIssues(error: Schema.SchemaError): Record<string, unknown>[] {
  return formatIssues(error.issue)
    .issues.slice(0, 5)
    .map((issue) => ({
      path:
        issue.path
          ?.map((segment) =>
            String(typeof segment === 'object' ? segment.key : segment),
          )
          .join('.') || '(root)',
      message: issue.message,
    }));
}

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();
