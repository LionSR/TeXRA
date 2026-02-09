// Local imports
import { StorageRecordSchema } from '@shared/schemas';
import { workspaceSM, WorkspaceStateKey } from '@common/state';

/**
 * Storage interface matching vscode.Memento API.
 * Used by PersistentMapManager for workspace state persistence.
 */
export interface MementoStorage {
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  update<T>(key: string, value: T): Thenable<void>;
}

/** Default debounce interval for persistence writes (ms). */
const SAVE_DEBOUNCE_MS = 300;

/**
 * Generic manager for map-based state with persistence support.
 * Handles common map operations and storage serialization.
 *
 * Persistence writes are debounced: rapid-fire mutations (e.g. streaming log
 * messages) coalesce into a single write at the trailing edge. In-memory state
 * is always immediately up-to-date; only the disk write is deferred.
 */
export abstract class PersistentMapManager<K extends string, V> {
  protected items: Map<K, V> = new Map();
  protected readonly storage: MementoStorage;
  protected readonly storageKey: WorkspaceStateKey;

  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private savePromise: Promise<void> | null = null;
  private pendingResolve: (() => void) | null = null;

  constructor(storageKey: WorkspaceStateKey, storage?: MementoStorage) {
    const resolvedStorage = storage ?? workspaceSM;
    if (!resolvedStorage) {
      throw new Error('workspace state manager is not initialized');
    }

    this.storage = resolvedStorage;
    this.storageKey = storageKey;
  }

  /** Add an entry to the map and persist it */
  async add(key: K, value: V): Promise<void> {
    this.items.set(key, value);
    await this.save();
  }

  /** Delete an entry and persist the change */
  async delete(key: K): Promise<void> {
    this.items.delete(key);
    await this.save();
  }

  /** Clear the map and persist the change */
  async clear(): Promise<void> {
    this.items.clear();
    await this.save();
  }

  /** Get a value for the key */
  get(key: K): V | undefined {
    return this.items.get(key);
  }

  /** Get a shallow copy of all entries */
  getAll(): Map<K, V> {
    return new Map(this.items);
  }

  /** Check if key exists */
  has(key: K): boolean {
    return this.items.has(key);
  }

  /**
   * Get or create an entry with lazy initialization.
   * Returns existing value or creates new one using factory function.
   */
  protected getOrCreate(key: K, factory: () => V): V {
    let value = this.items.get(key);
    if (!value) {
      value = factory();
      this.items.set(key, value);
    }
    return value;
  }

  /** Get all keys */
  keys(): K[] {
    return [...this.items.keys()];
  }

  /** Replace all entries (used during loading) */
  setAll(entries: Map<K, V>): void {
    this.items = new Map(entries);
  }

  /** Serialize a value before saving. Override for custom serialization. */
  protected serialize(value: V, _key: K): unknown {
    return value;
  }

  /** Deserialize a persisted value. Override for custom deserialization. */
  protected deserialize(data: unknown, _key: K): V | Promise<V> {
    return data as V;
  }

  /** Load state from persistence */
  async load(): Promise<void> {
    const record = this.loadRecord();
    if (Object.keys(record).length > 0) {
      await this.populateFromRecord(record);
    } else {
      this.items.clear();
    }
  }

  /** Load record from storage with null/invalid fallback */
  private loadRecord(): Record<string, unknown> {
    const stored = this.storage.get(this.storageKey);
    const result = StorageRecordSchema.safeParse(stored);
    if (!result.success) {
      console.warn(
        `[PersistentMapManager] Invalid storage data for ${this.storageKey}, resetting.`,
      );
      return {};
    }
    return result.data;
  }

  /**
   * Schedule a debounced persistence write.
   * In-memory state is already updated by callers before calling save(),
   * so this only defers the disk write. Multiple rapid calls coalesce into
   * one write at the trailing edge of the debounce window.
   *
   * When a new save supersedes a pending one, the same promise is reused
   * so all callers resolve when the eventual write completes.
   */
  async save(): Promise<void> {
    // If a timer is already pending, reset it (trailing-edge debounce).
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
    }

    if (!this.savePromise) {
      this.savePromise = new Promise<void>((resolve) => {
        this.pendingResolve = resolve;
      });
    }

    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      this.writeToStorage().then(
        () => resolve?.(),
        () => resolve?.(),
      );
    }, SAVE_DEBOUNCE_MS);

    return this.savePromise;
  }

  /**
   * Flush any pending debounced save immediately.
   * Call this during dispose / shutdown to avoid data loss.
   */
  async flush(): Promise<void> {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      await this.writeToStorage();
      this.pendingResolve?.();
      this.pendingResolve = null;
    } else if (this.savePromise) {
      await this.savePromise;
    }
  }

  /** Perform the actual serialization + storage write. */
  private async writeToStorage(): Promise<void> {
    const record: Record<string, unknown> = {};
    for (const [key, value] of this.items) {
      record[key] = this.serialize(value, key);
    }
    await this.storage.update(this.storageKey, record);
    this.savePromise = null;
  }

  private async populateFromRecord(
    record: Record<string, unknown>,
  ): Promise<void> {
    const entries: [K, V][] = [];
    for (const [key, value] of Object.entries(record)) {
      // await handles both sync and async deserialize implementations
      const deserialized = await this.deserialize(value, key as K);
      entries.push([key as K, deserialized]);
    }
    this.items = new Map(entries);
  }
}
