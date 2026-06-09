/**
 * Generic file-backed key-value store, now backed by Keyv.
 *
 * Each key is stored as a separate JSON file under `dir/` inside StorageFS.
 * The on-disk format is identical to the previous hand-rolled implementation
 * (pretty or compact JSON, no wrapper envelope) because we supply custom
 * serialize/deserialize functions to Keyv that strip its `{value, expires}`
 * envelope. This means existing stored files remain readable without migration.
 *
 * Keyv handles the get/set/delete/has surface; StorageFS operations that have
 * no Keyv equivalent (listKeys, modifiedAt, deleteDir) are kept as direct
 * StorageFS calls.
 */

import * as path from 'path';

import Keyv from 'keyv';

import { isFileNotFoundError } from '@common/errors/errorPredicates';
import { isFile } from '@utils/files/fsEntryType';
import { hasExtension } from '@utils/core/pathCore';
import { StorageFS } from '@utils/files/storageFS';

import { StorageFSKeyvAdapter } from './StorageFSKeyvAdapter';

export interface KVStoreOptions {
  /**
   * Write JSON without indentation. Use this for high-churn machine-owned
   * stores where repeated pretty-printing adds avoidable CPU and disk I/O.
   */
  compactJson?: boolean;
}

export class KVStore {
  private readonly keyv: Keyv;

  constructor(
    protected readonly dir: string,
    options: KVStoreOptions = {},
  ) {
    const indent = options.compactJson ? undefined : 2;
    const adapter = new StorageFSKeyvAdapter(dir);
    this.keyv = new Keyv({
      store: adapter,
      // No namespace prefix — the directory already provides isolation.
      namespace: undefined,
      // Custom serializer preserves the existing on-disk format:
      // files contain plain JSON (not Keyv's {"value":...,"expires":...} envelope).
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

  // ── Operations without Keyv equivalents ─────────────────────────────────────

  async modifiedAt(key: string): Promise<number | undefined> {
    const filePath = path.join(this.dir, `${encodeURIComponent(key)}.json`);
    try {
      return (await StorageFS.stat(filePath)).mtime;
    } catch (err) {
      if (isFileNotFoundError(err)) return undefined;
      throw err;
    }
  }

  async listKeys(prefix?: string): Promise<string[]> {
    let entries: [string, number][];
    try {
      entries = await StorageFS.readDir(this.dir);
    } catch (err) {
      if (isFileNotFoundError(err)) return [];
      throw err;
    }
    return entries
      .filter(([name, type]) => isFile(type) && hasExtension(name, '.json'))
      .map(([name]) => StorageFSKeyvAdapter.filenameToKey(name))
      .filter((key) => !prefix || key.startsWith(prefix));
  }

  async deleteDir(): Promise<void> {
    await this.keyv.clear();
  }
}
