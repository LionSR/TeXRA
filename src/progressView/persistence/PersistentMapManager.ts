// Local imports
import { workspaceSM, WorkspaceStateKey } from '@common/state/stateManager';
import { streamStorage } from './FileBasedStreamStorage';

export interface StateStorage {
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  update<T>(key: string, value: T): Thenable<void>;
}

export interface PersistentMapManagerOptions {
  /** Use file-based storage instead of workspaceState for lazy loading */
  useFileStorage?: boolean;
}

/**
 * Generic manager for map-based state with persistence support.
 * Handles common map operations and storage serialization.
 *
 * Supports two storage modes:
 * - workspaceState: All data in VS Code memento (legacy, limited by IPC threshold)
 * - file-based: Data stored in files per key, loaded lazily (recommended for large data)
 */
export abstract class PersistentMapManager<K extends string, V> {
  protected items: Map<K, V> = new Map();
  protected readonly storage: StateStorage;
  protected readonly storageKey: WorkspaceStateKey;
  protected readonly useFileStorage: boolean;
  /** Track which keys exist (for file storage mode) */
  protected knownKeys: Set<K> = new Set();
  /** Track which keys have been loaded from file */
  protected loadedKeys: Set<K> = new Set();

  constructor(
    storageKey: WorkspaceStateKey,
    storage?: StateStorage,
    options?: PersistentMapManagerOptions,
  ) {
    const resolvedStorage = storage ?? workspaceSM;
    if (!resolvedStorage) {
      throw new Error('workspace state manager is not initialized');
    }

    this.storage = resolvedStorage;
    this.storageKey = storageKey;
    this.useFileStorage = options?.useFileStorage ?? false;
  }

  /** Add an entry to the map and persist it */
  async add(key: K, value: V): Promise<void> {
    this.items.set(key, value);
    this.knownKeys.add(key);
    this.loadedKeys.add(key);
    await this.saveEntry(key, value);
  }

  /** Delete an entry and persist the change */
  async delete(key: K): Promise<void> {
    this.items.delete(key);
    this.knownKeys.delete(key);
    this.loadedKeys.delete(key);
    if (this.useFileStorage) {
      await streamStorage.delete(this.storageKey, key);
    } else {
      await this.save();
    }
  }

  /** Clear the map and persist the change */
  async clear(): Promise<void> {
    if (this.useFileStorage) {
      // Delete all files for this data type
      for (const key of this.knownKeys) {
        await streamStorage.delete(this.storageKey, key);
      }
    }
    this.items.clear();
    this.knownKeys.clear();
    this.loadedKeys.clear();
    if (!this.useFileStorage) {
      await this.save();
    }
  }

  /** Get a value for the key (loads from file if using file storage) */
  get(key: K): V | undefined {
    return this.items.get(key);
  }

  /**
   * Get a value for the key, loading from file if necessary (async version).
   * Use this for file-based storage to ensure data is loaded.
   */
  async getAsync(key: K): Promise<V | undefined> {
    if (this.useFileStorage && !this.loadedKeys.has(key) && this.knownKeys.has(key)) {
      await this.loadEntry(key);
    }
    return this.items.get(key);
  }

  /** Get a shallow copy of all entries */
  getAll(): Map<K, V> {
    return new Map(this.items);
  }

  /** Check if key exists */
  has(key: K): boolean {
    return this.useFileStorage ? this.knownKeys.has(key) : this.items.has(key);
  }

  /** Get all keys */
  keys(): K[] {
    return this.useFileStorage
      ? [...this.knownKeys]
      : [...this.items.keys()];
  }

  /** Replace all entries (used during loading) */
  setAll(entries: Map<K, V>): void {
    this.items = new Map(entries);
    this.knownKeys = new Set(entries.keys());
    this.loadedKeys = new Set(entries.keys());
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
    if (this.useFileStorage) {
      // First, migrate any existing data from workspaceState to files
      await this.migrateFromWorkspaceState();
      await this.loadFromFiles();
    } else {
      await this.loadFromWorkspaceState();
    }
  }

  /**
   * Migrate existing data from workspaceState to file storage.
   * This is a one-time migration that clears the old workspaceState data.
   */
  private async migrateFromWorkspaceState(): Promise<void> {
    const saved = this.storage.get<Record<string, unknown>>(this.storageKey);

    if (!saved || Object.keys(saved).length === 0) {
      return; // Nothing to migrate
    }

    // Migrate each entry to file storage
    for (const [key, value] of Object.entries(saved)) {
      const deserialized = await this.deserialize(value, key as K);
      const serialized = this.serialize(deserialized, key as K);
      await streamStorage.save(this.storageKey, key, serialized);
    }

    // Clear the old workspaceState data
    await this.storage.update(this.storageKey, undefined as never);
  }

  /** Load only the list of keys (for file storage mode) */
  private async loadFromFiles(): Promise<void> {
    // Get list of existing streams from file system
    const streamIds = await streamStorage.listStreams(this.storageKey);
    this.knownKeys = new Set(streamIds as K[]);
    this.items.clear();
    this.loadedKeys.clear();
  }

  /** Load from workspaceState (legacy mode) */
  private async loadFromWorkspaceState(): Promise<void> {
    const saved = this.storage.get<Record<string, unknown>>(
      this.storageKey,
      {},
    );

    if (saved && Object.keys(saved).length > 0) {
      await this.populateFromRecord(saved);
    } else {
      this.items.clear();
      this.knownKeys.clear();
      this.loadedKeys.clear();
    }
  }

  /** Load a single entry from file storage */
  protected async loadEntry(key: K): Promise<void> {
    if (!this.useFileStorage) return;

    const data = await streamStorage.load<unknown>(this.storageKey, key);
    if (data !== null) {
      const deserialized = await this.deserialize(data, key);
      this.items.set(key, deserialized);
      this.loadedKeys.add(key);
    }
  }

  /** Ensure an entry is loaded (for file storage mode) */
  async ensureLoaded(key: K): Promise<void> {
    if (this.useFileStorage && !this.loadedKeys.has(key) && this.knownKeys.has(key)) {
      await this.loadEntry(key);
    }
  }

  /** Save current state to persistence */
  async save(): Promise<void> {
    if (this.useFileStorage) {
      // Save all modified entries
      for (const [key, value] of this.items.entries()) {
        await this.saveEntry(key, value);
      }
    } else {
      const serialized = [...this.items.entries()].map(([key, value]) => [
        key,
        this.serialize(value, key),
      ]);
      const obj = Object.fromEntries(serialized);
      await this.storage.update(this.storageKey, obj);
    }
  }

  /** Save a single entry (for file storage mode) */
  protected async saveEntry(key: K, value: V): Promise<void> {
    if (this.useFileStorage) {
      const serialized = this.serialize(value, key);
      await streamStorage.save(this.storageKey, key, serialized);
    } else {
      await this.save();
    }
  }

  private async populateFromRecord(
    record: Record<string, unknown>,
  ): Promise<void> {
    const entries: [K, V][] = [];
    for (const [key, value] of Object.entries(record)) {
      const deserialized = await this.deserialize(value, key as K);
      entries.push([key as K, deserialized]);
    }
    this.items = new Map(entries);
    this.knownKeys = new Set(this.items.keys());
    this.loadedKeys = new Set(this.items.keys());
  }
}
