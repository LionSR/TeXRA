/**
 * Execution-scoped key-value store infrastructure.
 *
 * Provides a unified storage interface for all execution-scoped data.
 * All keys are automatically namespaced to the execution context.
 */

import * as path from 'path';

import { isFileNotFoundError } from '@common/errors';
import { isFile } from '@common/files/fsEntryType';

import { StorageFS } from '@utils/files';
import type { ExecutionId } from '@shared/schemas';

/**
 * Execution-scoped key-value store.
 *
 * All keys are automatically namespaced to the execution context.
 * Values are JSON-serialized transparently.
 */
export interface ExecutionKVStore {
  read<T = unknown>(key: string): Promise<T | undefined>;
  write<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  listKeys(prefix?: string): Promise<string[]>;
  clear(): Promise<void>;
  getExecutionId(): ExecutionId;
}

// Storage directory for executions
const EXECUTIONS_DIR = 'executions';

/**
 * Executes an async operation, returning a fallback value if file/directory not found.
 * Re-throws all other errors.
 */
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

/**
 * Extracts key name from a JSON filename.
 */
function jsonFileToKey(filename: string): string {
  return filename.replace(/\.json$/, '');
}

/**
 * StorageFS-backed implementation of ExecutionKVStore.
 * Stores data in executions/{executionId}/{key}.json
 */
class StorageFSKVStore implements ExecutionKVStore {
  constructor(private readonly executionId: ExecutionId) {}

  private keyToPath(key: string): string {
    // Sanitize key to prevent path traversal
    const sanitized = key.replaceAll('..', '_').replaceAll(/[<>:"|?*]/g, '_');
    return path.join(EXECUTIONS_DIR, this.executionId, `${sanitized}.json`);
  }

  async read<T = unknown>(key: string): Promise<T | undefined> {
    return withNotFoundFallback(
      () => StorageFS.readJson<T>(this.keyToPath(key)),
      undefined,
    );
  }

  async write<T = unknown>(key: string, value: T): Promise<void> {
    const dir = path.join(EXECUTIONS_DIR, this.executionId);
    await StorageFS.ensureDir(dir);
    await StorageFS.writeJson(this.keyToPath(key), value);
  }

  async delete(key: string): Promise<void> {
    await withNotFoundFallback(
      () => StorageFS.delete(this.keyToPath(key)),
      undefined,
    );
  }

  async exists(key: string): Promise<boolean> {
    return StorageFS.exists(this.keyToPath(key));
  }

  async listKeys(prefix?: string): Promise<string[]> {
    const dir = path.join(EXECUTIONS_DIR, this.executionId);
    const entries = await withNotFoundFallback(
      () => StorageFS.readDir(dir),
      [],
    );
    return entries
      .filter(([name, type]) => {
        if (!isFile(type) || !name.endsWith('.json')) return false;
        return !prefix || jsonFileToKey(name).startsWith(prefix);
      })
      .map(([name]) => jsonFileToKey(name));
  }

  async clear(): Promise<void> {
    const dir = path.join(EXECUTIONS_DIR, this.executionId);
    await withNotFoundFallback(() => StorageFS.delete(dir), undefined);
  }

  getExecutionId(): ExecutionId {
    return this.executionId;
  }
}

// Cached stores for reuse
const storeCache = new Map<ExecutionId, ExecutionKVStore>();

/**
 * Get or create a store for an execution.
 */
export function getExecutionStore(executionId: ExecutionId): ExecutionKVStore {
  const cached = storeCache.get(executionId);
  if (cached) return cached;

  const store = new StorageFSKVStore(executionId);
  storeCache.set(executionId, store);
  return store;
}
