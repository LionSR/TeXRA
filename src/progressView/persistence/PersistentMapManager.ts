// Local imports
import { workspaceSM, WorkspaceStateKey } from '@common/state/stateManager';
import { StorageRecordSchema } from './schemaUtils';

export interface StateStorage {
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  update<T>(key: string, value: T): Thenable<void>;
}

/**
 * Generic manager for map-based state with persistence support.
 * Handles common map operations and storage serialization.
 */
export abstract class PersistentMapManager<K extends string, V> {
  protected items: Map<K, V> = new Map();
  protected readonly storage: StateStorage;
  protected readonly storageKey: WorkspaceStateKey;

  constructor(storageKey: WorkspaceStateKey, storage?: StateStorage) {
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

  /** Get all keys */
  keys(): K[] {
    return [...this.items.keys()];
  }

  /** Replace all entries (used during loading) */
  setAll(entries: Map<K, V>): void {
    this.items = new Map(entries);
  }

  /**
   * Get or create an entry with lazy initialization.
   * Returns existing value or creates new one using factory function.
   * Note: Does NOT persist - call save() after modifications.
   */
  protected getOrCreateEntry(key: K, factory: () => V): V {
    let value = this.items.get(key);
    if (!value) {
      value = factory();
      this.items.set(key, value);
    }
    return value;
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
  protected loadRecord(): Record<string, unknown> {
    return StorageRecordSchema.parse(this.storage.get(this.storageKey));
  }

  /** Save current state to persistence */
  async save(): Promise<void> {
    const record: Record<string, unknown> = {};
    for (const [key, value] of this.items) {
      record[key] = this.serialize(value, key);
    }
    await this.storage.update(this.storageKey, record);
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
