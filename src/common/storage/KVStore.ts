/**
 * Generic StorageFS-backed key-value store.
 *
 * Keyv owns the key-value semantics; this module owns the StorageFS file layout.
 * Each key is stored as one JSON file, and custom Keyv serialization preserves
 * the existing plain-JSON on-disk format rather than Keyv's `{value, expires}`
 * envelope.
 */

import * as path from 'node:path';

import Keyv, { type KeyvStoreAdapter, type StoredData } from 'keyv';

import { isFileNotFoundError } from '@common/errors/errorPredicates';
import { isFile } from '@utils/files/fsEntryType';
import { hasExtension } from '@utils/core/pathCore';
import { StorageFS } from '@utils/files/storageFS';

function keyToPath(dir: string, key: string): string {
  return path.join(dir, `${encodeURIComponent(key)}.json`);
}

function filenameToKey(filename: string): string {
  return decodeURIComponent(filename.replace(/\.json$/, ''));
}

async function withMissingFallback<T>(
  operation: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    if (isFileNotFoundError(err)) return fallback;
    throw err;
  }
}

function createStorageStore(dir: string): KeyvStoreAdapter {
  let dirEnsured = false;

  return {
    opts: {},
    namespace: undefined,

    // Keyv subscribes to store error events when present. StorageFS surfaces
    // failures by rejecting the operation promise, so there is no event source.
    on(): KeyvStoreAdapter {
      return this;
    },

    async get<Value>(key: string): Promise<StoredData<Value> | undefined> {
      const raw = await withMissingFallback(
        () => StorageFS.read(keyToPath(dir, key)),
        undefined,
      );
      // Keyv expects the serialized store value here and applies our
      // `deserialize` hook before returning from KVStore.read().
      return raw as StoredData<Value> | undefined;
    },

    async set(key: string, value: unknown): Promise<void> {
      if (!dirEnsured) {
        await StorageFS.ensureDir(dir);
        dirEnsured = true;
      }
      // Keyv has already run the serializer, so StorageFS receives raw JSON.
      // Atomic: a torn flow_{id}.json on an unclean exit makes the run fail to
      // parse on resume and silently restart from scratch (losing applied edits).
      await StorageFS.writeAtomic(keyToPath(dir, key), value as string);
    },

    async delete(key: string): Promise<boolean> {
      return withMissingFallback(async () => {
        await StorageFS.delete(keyToPath(dir, key));
        return true;
      }, false);
    },

    async clear(): Promise<void> {
      await withMissingFallback(
        () => StorageFS.delete(dir, { recursive: true }),
        undefined,
      );
      dirEnsured = false;
    },

    async has(key: string): Promise<boolean> {
      return StorageFS.exists(keyToPath(dir, key));
    },
  };
}

export interface KVStoreOptions {
  /**
   * Write JSON without indentation. Use this for high-churn machine-owned
   * stores where repeated pretty-printing adds avoidable CPU and disk I/O.
   */
  compactJson?: boolean;
  /** Propagate adapter failures instead of converting them to false/missing. */
  throwOnErrors?: boolean;
}

export class KVStore {
  private readonly keyv: Keyv;

  constructor(
    private readonly dir: string,
    options: KVStoreOptions = {},
  ) {
    const indent = options.compactJson ? undefined : 2;
    this.keyv = new Keyv({
      store: createStorageStore(dir),
      // The directory is the namespace; keys are stored literally.
      namespace: undefined,
      useKeyPrefix: false,
      throwOnErrors: options.throwOnErrors,
      serialize: (data) => JSON.stringify(data.value, null, indent),
      deserialize: (raw) => ({ value: JSON.parse(raw) }),
    });
  }

  async read<T = unknown>(key: string): Promise<T | undefined> {
    return this.keyv.get<T>(key);
  }

  async write<T = unknown>(key: string, value: T): Promise<void> {
    await this.keyv.set(key, value);
  }

  async delete(key: string): Promise<void> {
    await this.keyv.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.keyv.has(key);
  }

  async modifiedAt(key: string): Promise<number | undefined> {
    return withMissingFallback(
      async () => (await StorageFS.stat(keyToPath(this.dir, key))).mtime,
      undefined,
    );
  }

  async listKeys(prefix?: string): Promise<string[]> {
    const entries = await withMissingFallback(
      () => StorageFS.readDir(this.dir),
      [],
    );
    return entries
      .filter(([name, type]) => isFile(type) && hasExtension(name, '.json'))
      .map(([name]) => filenameToKey(name))
      .filter((key) => !prefix || key.startsWith(prefix));
  }

  async deleteDir(): Promise<void> {
    await this.keyv.clear();
  }
}
