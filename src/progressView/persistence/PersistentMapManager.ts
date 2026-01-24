// Local imports
import { workspaceSM, WorkspaceStateKey } from '@common/state/stateManager';

export interface StateStorage {
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  update<T>(key: string, value: T): Thenable<void>;
}

/** Default debounce delay for persistence saves (ms) */
const DEFAULT_SAVE_DEBOUNCE_MS = 500;

/**
 * Generic manager for map-based state with persistence support.
 * Handles common map operations and storage serialization.
 *
 * Performance: Uses debounced saves to reduce disk I/O when multiple
 * updates happen in quick succession (common during streaming).
 */
export abstract class PersistentMapManager<K extends string, V> {
  protected items: Map<K, V> = new Map();
  protected readonly storage: StateStorage;
  protected readonly storageKey: WorkspaceStateKey;

  /** Debounce timer handle for save operations */
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  /** Promise for the pending save operation */
  private pendingSave: Promise<void> | null = null;

  /** Resolve function for the pending save promise */
  private pendingSaveResolve: (() => void) | null = null;

  /** Debounce delay in milliseconds */
  protected readonly saveDebounceMs: number;

  constructor(
    storageKey: WorkspaceStateKey,
    storage?: StateStorage,
    saveDebounceMs: number = DEFAULT_SAVE_DEBOUNCE_MS,
  ) {
    const resolvedStorage = storage ?? workspaceSM;
    if (!resolvedStorage) {
      throw new Error('workspace state manager is not initialized');
    }

    this.storage = resolvedStorage;
    this.storageKey = storageKey;
    this.saveDebounceMs = saveDebounceMs;
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
    const saved = this.storage.get<Record<string, unknown>>(
      this.storageKey,
      {},
    );

    if (Object.keys(saved).length > 0) {
      await this.populateFromRecord(saved);
    } else {
      this.items.clear();
    }
  }

  /**
   * Save current state to persistence with debouncing.
   * Multiple rapid calls will be coalesced into a single save operation.
   * Returns a promise that resolves when the save completes.
   */
  async save(): Promise<void> {
    // If there's already a pending save, just wait for it
    if (this.pendingSave) {
      // Reset the debounce timer to extend the delay
      if (this.saveTimer) {
        clearTimeout(this.saveTimer);
      }
      this.saveTimer = setTimeout(() => this.executeSave(), this.saveDebounceMs);
      return this.pendingSave;
    }

    // Create a new pending save promise
    this.pendingSave = new Promise<void>((resolve) => {
      this.pendingSaveResolve = resolve;
    });

    // Start the debounce timer
    this.saveTimer = setTimeout(() => this.executeSave(), this.saveDebounceMs);

    return this.pendingSave;
  }

  /**
   * Execute the actual save operation.
   * Called by the debounce timer.
   */
  private async executeSave(): Promise<void> {
    this.saveTimer = null;

    const record: Record<string, unknown> = {};
    for (const [key, value] of this.items) {
      record[key] = this.serialize(value, key);
    }

    try {
      await this.storage.update(this.storageKey, record);
    } finally {
      // Resolve the pending promise and reset state
      if (this.pendingSaveResolve) {
        this.pendingSaveResolve();
      }
      this.pendingSave = null;
      this.pendingSaveResolve = null;
    }
  }

  /**
   * Force an immediate save, bypassing debounce.
   * Useful when the extension is deactivating.
   */
  async saveImmediate(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    const record: Record<string, unknown> = {};
    for (const [key, value] of this.items) {
      record[key] = this.serialize(value, key);
    }

    await this.storage.update(this.storageKey, record);

    // Resolve any pending promise
    if (this.pendingSaveResolve) {
      this.pendingSaveResolve();
    }
    this.pendingSave = null;
    this.pendingSaveResolve = null;
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
