// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { workspaceSM, WorkspaceStateKey } from '@common/state/stateManager';

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
  private readonly legacyKeyRoots: string[];

  constructor(
    storageKey: WorkspaceStateKey,
    storage?: StateStorage,
    legacyKeyRoots: string[] = [],
  ) {
    const resolvedStorage = storage ?? workspaceSM;
    if (!resolvedStorage) {
      throw new Error('workspace state manager is not initialized');
    }

    this.storage = resolvedStorage;
    this.storageKey = storageKey;
    this.legacyKeyRoots = legacyKeyRoots;
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
    const saved = this.storage.get<Record<string, unknown>>(
      this.storageKey,
      {},
    );

    if (saved && Object.keys(saved).length > 0) {
      await this.populateFromRecord(saved);
      return;
    }

    const migrated = await this.migrateLegacyState();
    if (!migrated) {
      this.items.clear();
    }
  }

  /** Save current state to persistence */
  async save(): Promise<void> {
    const serialized = [...this.items.entries()].map(([key, value]) => [
      key,
      this.serialize(value, key),
    ]);
    const obj = Object.fromEntries(serialized);
    await this.storage.update(this.storageKey, obj);
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
  }

  private async migrateLegacyState(): Promise<boolean> {
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspacePath) {
      return false;
    }

    const candidates = [this.storageKey as string, ...this.legacyKeyRoots];

    for (const root of candidates) {
      const legacyKey = `${root}.${workspacePath}`;
      const legacy = this.storage.get<Record<string, unknown>>(legacyKey, {});
      if (!legacy || Object.keys(legacy).length === 0) {
        continue;
      }

      await this.populateFromRecord(legacy);
      await this.save();
      await this.storage.update(legacyKey, undefined as never);
      return true;
    }

    return false;
  }
}
