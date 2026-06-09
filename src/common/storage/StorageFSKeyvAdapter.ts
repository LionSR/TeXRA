/**
 * Keyv StorageAdapter backed by StorageFS.
 *
 * Stores each key as a separate JSON file in `dir/`, using the same
 * percent-encoded filename scheme as the old KVStore. The adapter satisfies
 * the KeyvStoreAdapter interface so KVStore can delegate get/set/delete/has
 * to Keyv while keeping file-per-key semantics and StorageFS platform
 * abstraction.
 *
 * Keyv calls adapter methods with already-serialized values (plain JSON
 * strings), so this adapter writes and reads raw strings — no extra
 * serialization layer on top.
 */

import * as path from 'path';

import { isFileNotFoundError } from '@common/errors/errorPredicates';
import { StorageFS } from '@utils/files/storageFS';

import type { KeyvStoreAdapter, StoredData } from 'keyv';

export class StorageFSKeyvAdapter implements KeyvStoreAdapter {
  opts = {};
  namespace: string | undefined = undefined;
  private dirEnsured = false;

  constructor(private readonly dir: string) {}

  /** No-op: Keyv events are emitted by Keyv itself, not by the adapter. */
  on(_event: string, _listener: (...args: unknown[]) => void): this {
    return this;
  }

  private keyToPath(key: string): string {
    return path.join(this.dir, `${encodeURIComponent(key)}.json`);
  }

  static filenameToKey(filename: string): string {
    return decodeURIComponent(filename.replace(/\.json$/, ''));
  }

  async get<Value>(key: string): Promise<StoredData<Value> | undefined> {
    try {
      const raw = await StorageFS.read(this.keyToPath(key));
      // Keyv's custom deserializer will parse this string; return as-is.
      return raw as StoredData<Value>;
    } catch (err) {
      if (isFileNotFoundError(err)) return undefined;
      throw err;
    }
  }

  async set(key: string, value: unknown): Promise<void> {
    if (!this.dirEnsured) {
      await StorageFS.ensureDir(this.dir);
      this.dirEnsured = true;
    }
    // `value` is already the serialized string produced by Keyv's serialize function.
    await StorageFS.write(this.keyToPath(key), value as string);
  }

  async delete(key: string): Promise<boolean> {
    try {
      await StorageFS.delete(this.keyToPath(key));
      return true;
    } catch (err) {
      if (isFileNotFoundError(err)) return false;
      throw err;
    }
  }

  async clear(): Promise<void> {
    try {
      await StorageFS.delete(this.dir, { recursive: true });
    } catch (err) {
      if (!isFileNotFoundError(err)) throw err;
    }
    this.dirEnsured = false;
  }

  async has(key: string): Promise<boolean> {
    return StorageFS.exists(this.keyToPath(key));
  }

  // iterator is intentionally omitted. KVStore exposes listKeys() via direct
  // StorageFS calls; Keyv's generateIterator path is not needed. Including an
  // iterator without a recognised opts.dialect/url causes Keyv's
  // _checkIterableAdapter() to crash on opts.url.includes(), so we leave the
  // method off entirely until we have a concrete use-case for keyv.iterator().
}
