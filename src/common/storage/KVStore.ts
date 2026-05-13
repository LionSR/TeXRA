/**
 * Generic file-backed key-value store.
 *
 * Stores each key as a separate JSON file under a configurable directory
 * inside StorageFS (workspace-scoped). Keys are percent-encoded for
 * filesystem safety and decoded on read-back, so the mapping is
 * reversible and collision-free.
 */

import * as path from 'path';

import { isFileNotFoundError } from '@common/errors/errorPredicates';
import { isFile } from '@common/files/fsEntryType';
import { hasExtension } from '@utils/core/pathCore';
import { StorageFS } from '@utils/files/storageFS';

async function withNotFoundFallback<T>(
  operation: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return fallback;
    }
    throw error;
  }
}

export interface KVStoreOptions {
  /**
   * Write JSON without indentation. Use this for high-churn machine-owned
   * stores where repeated pretty-printing adds avoidable CPU and disk I/O.
   */
  compactJson?: boolean;
}

export class KVStore {
  private dirEnsured = false;

  constructor(
    private readonly dir: string,
    private readonly options: KVStoreOptions = {},
  ) {}

  private keyToPath(key: string): string {
    return path.join(this.dir, `${encodeURIComponent(key)}.json`);
  }

  private static filenameToKey(filename: string): string {
    return decodeURIComponent(filename.replace(/\.json$/, ''));
  }

  async read<T = unknown>(key: string): Promise<T | undefined> {
    return withNotFoundFallback(
      () => StorageFS.readJson<T>(this.keyToPath(key)),
      undefined,
    );
  }

  async write<T = unknown>(key: string, value: T): Promise<void> {
    if (!this.dirEnsured) {
      await StorageFS.ensureDir(this.dir);
      this.dirEnsured = true;
    }
    const indent = this.options.compactJson ? undefined : 2;
    await StorageFS.write(
      this.keyToPath(key),
      JSON.stringify(value, null, indent),
    );
  }

  async delete(key: string): Promise<void> {
    await withNotFoundFallback(
      () => StorageFS.delete(this.keyToPath(key)),
      undefined,
    );
  }

  async deleteDir(): Promise<void> {
    await withNotFoundFallback(
      () => StorageFS.delete(this.dir, { recursive: true }),
      undefined,
    );
    this.dirEnsured = false;
  }

  async exists(key: string): Promise<boolean> {
    return StorageFS.exists(this.keyToPath(key));
  }

  async listKeys(prefix?: string): Promise<string[]> {
    const entries = await withNotFoundFallback(
      () => StorageFS.readDir(this.dir),
      [],
    );
    return entries
      .filter(([name, type]) => isFile(type) && hasExtension(name, '.json'))
      .map(([name]) => KVStore.filenameToKey(name))
      .filter((key) => !prefix || key.startsWith(prefix));
  }
}
