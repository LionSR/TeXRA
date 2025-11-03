// Local imports - progress view
import { StatePersistenceManager } from './StatePersistenceManager';
// Local imports
import { WorkspaceStateKey } from '@common/state/stateManager';

/**
 * Generic manager for map-based state with persistence support.
 * Handles common map operations and storage serialization.
 */
export abstract class PersistentMapManager<K extends string, V> {
  protected items: Map<K, V> = new Map();

  constructor(
    protected readonly persistence: StatePersistenceManager,
    protected readonly storageKey: WorkspaceStateKey,
  ) {}

  /** Add an entry to the map and persist it */
  add(key: K, value: V): void {
    this.items.set(key, value);
    this.save();
  }

  /** Delete an entry and persist the change */
  delete(key: K): void {
    this.items.delete(key);
    this.save();
  }

  /** Clear the map and persist the change */
  clear(): void {
    this.items.clear();
    this.save();
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
    return Array.from(this.items.keys());
  }

  /** Replace all entries (used during loading) */
  setAll(entries: Map<K, V>): void {
    this.items = new Map(entries);
  }

  /** Serialize a value before saving */
  protected serialize(value: V, _key: K): unknown {
    return value as unknown;
  }

  /**
   * Deserialize a persisted value. Can perform async operations like cleanup.
   */
  protected async deserialize(data: unknown, _key: K): Promise<V> {
    return data as V;
  }

  /** Load state from persistence */
  async load(): Promise<void> {
    const saved = await this.persistence.load<Record<string, unknown>>(
      this.storageKey,
      {},
    );

    if (saved && Object.keys(saved).length > 0) {
      const entries: [K, V][] = [];
      for (const [key, value] of Object.entries(saved)) {
        const deserialized = await this.deserialize(value, key as K);
        entries.push([key as K, deserialized]);
      }
      this.items = new Map(entries);
    } else {
      this.items.clear();
    }
  }

  /** Save current state to persistence */
  save(): void {
    const serialized = Array.from(this.items.entries()).map(([key, value]) => [
      key,
      this.serialize(value, key),
    ]);
    const obj = Object.fromEntries(serialized);
    this.persistence.save(this.storageKey, obj);
  }
}
