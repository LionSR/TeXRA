/**
 * Generic StorageFS-backed key-value store.
 *
 * A key defaults to one plain-JSON file, `encodeURIComponent(key).json`, and
 * extension-aware methods support caller-owned text formats in the same
 * directory. The directory listing is the index. Failures are never swallowed:
 * a missing file reads as `undefined`, every other error throws to the caller.
 */

import * as path from 'node:path';

import { isFileNotFoundError } from '@common/errors/errorPredicates';
import { isFile } from '@utils/files/fsEntryType';
import { hasExtension } from '@utils/core/pathCore';
import { StorageFS } from '@utils/files/storageFS';

function keyToPath(dir: string, key: string, extension = '.json'): string {
  return path.join(dir, `${encodeURIComponent(key)}${extension}`);
}

function filenameToKey(filename: string, extension = '.json'): string {
  return decodeURIComponent(filename.slice(0, -extension.length));
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

export interface KVStoreOptions {
  /**
   * Write JSON without indentation. Use this for high-churn machine-owned
   * stores where repeated pretty-printing adds avoidable CPU and disk I/O.
   */
  compactJson?: boolean;
}

export class KVStore {
  private readonly indent: number | undefined;

  constructor(
    private readonly dir: string,
    options: KVStoreOptions = {},
  ) {
    this.indent = options.compactJson ? undefined : 2;
  }

  async read<T = unknown>(key: string): Promise<T | undefined> {
    const raw = await withMissingFallback(
      () => StorageFS.read(keyToPath(this.dir, key)),
      undefined,
    );
    if (raw === undefined) return undefined;
    return JSON.parse(raw) as T;
  }

  /** Read a non-JSON storage value without imposing a serialization format. */
  async readText(key: string, extension: string): Promise<string | undefined> {
    return withMissingFallback(
      () => StorageFS.read(keyToPath(this.dir, key, extension)),
      undefined,
    );
  }

  /** Read a bounded suffix from a caller-owned text value. */
  async readTextTail(
    key: string,
    extension: string,
    maxBytes: number,
  ): Promise<string | undefined> {
    return withMissingFallback(
      () => StorageFS.readTail(keyToPath(this.dir, key, extension), maxBytes),
      undefined,
    );
  }

  /** Append text to one storage value; callers own record framing. */
  async appendText(
    key: string,
    extension: string,
    content: string,
  ): Promise<void> {
    await StorageFS.ensureDir(this.dir);
    await StorageFS.appendFile(keyToPath(this.dir, key, extension), content);
  }

  /** Atomically replace a caller-owned text value. */
  async writeTextAtomic(
    key: string,
    extension: string,
    content: string,
  ): Promise<void> {
    await StorageFS.ensureDir(this.dir);
    await StorageFS.writeAtomic(keyToPath(this.dir, key, extension), content);
  }

  async write<T = unknown>(key: string, value: T): Promise<void> {
    // Ensured on every write, not latched once: `dir` is storage-root
    // relative, so a cached store outlives the root it first saw (workspace
    // switch, test temp platform) and a latch would write into a directory
    // that no longer exists. mkdir on an existing directory is cheap.
    await StorageFS.ensureDir(this.dir);
    // Atomic: a torn flow_{id}.json on an unclean exit makes the run fail to
    // parse on resume and silently restart from scratch (losing applied edits).
    await StorageFS.writeAtomic(
      keyToPath(this.dir, key),
      JSON.stringify(value, null, this.indent),
    );
  }

  async delete(key: string): Promise<void> {
    await this.deleteWithExtension(key, '.json');
  }

  async deleteWithExtension(key: string, extension: string): Promise<void> {
    await withMissingFallback(
      () => StorageFS.delete(keyToPath(this.dir, key, extension)),
      undefined,
    );
  }

  async exists(key: string): Promise<boolean> {
    return this.existsWithExtension(key, '.json');
  }

  async existsWithExtension(key: string, extension: string): Promise<boolean> {
    return StorageFS.exists(keyToPath(this.dir, key, extension));
  }

  async modifiedAt(key: string): Promise<number | undefined> {
    return this.modifiedAtWithExtension(key, '.json');
  }

  async modifiedAtWithExtension(
    key: string,
    extension: string,
  ): Promise<number | undefined> {
    return withMissingFallback(
      async () =>
        (await StorageFS.stat(keyToPath(this.dir, key, extension))).mtime,
      undefined,
    );
  }

  async listKeys(prefix?: string): Promise<string[]> {
    return this.listKeysWithExtension('.json', prefix);
  }

  /** List keys whose files use a caller-owned extension. */
  async listKeysWithExtension(
    extension: string,
    prefix?: string,
  ): Promise<string[]> {
    const entries = await withMissingFallback(
      () => StorageFS.readDir(this.dir),
      [],
    );
    return entries
      .filter(([name, type]) => isFile(type) && hasExtension(name, extension))
      .map(([name]) => filenameToKey(name, extension))
      .filter((key) => !prefix || key.startsWith(prefix));
  }

  async deleteDir(): Promise<void> {
    await withMissingFallback(
      () => StorageFS.delete(this.dir, { recursive: true }),
      undefined,
    );
  }
}
