/**
 * Execution-scoped key-value store infrastructure.
 *
 * This module provides a unified storage interface for all execution-scoped data,
 * replacing the fragmented TaskRunFileService and ToolUseSnapshotStore patterns.
 *
 * Architecture:
 * - ExecutionKVStore: Consumer-facing interface, auto-scoped to execution
 * - ExecutionStorageRegistry: Internal factory and lifecycle manager
 * - StorageFSKVStore: VS Code storage backend implementation
 *
 * Note: This module is platform-agnostic - it uses helpers from @common/errors
 * instead of importing vscode directly for error handling and file type checks.
 */

import * as path from 'path';

import { isFileNotFoundError } from '@common/errors';
import { isFile, isDirectory } from '@common/files/fsEntryType';

import { StorageFS } from '@utils/files';
import type { ExecutionId } from '@shared/schemas';

/**
 * Execution-scoped key-value store.
 *
 * All keys are automatically namespaced to the execution context.
 * No executionId threading - callers work within single execution context.
 *
 * Design principles:
 * - Automatic serialization: values are JSON-serialized transparently
 * - Type-safe: caller determines key naming conventions
 * - Atomic operations: write with single call, no partial state
 */
export interface ExecutionKVStore {
  // Core operations
  read<T = unknown>(key: string): Promise<T | undefined>;
  write<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;

  // Enumeration
  listKeys(prefix?: string): Promise<string[]>;

  // Bulk operations
  clear(): Promise<void>;

  // Context
  getExecutionId(): ExecutionId;
}

/**
 * Factory and registry for execution-scoped stores.
 * Manages lifecycle, cleanup, and multi-execution queries.
 */
export interface ExecutionStorageRegistry {
  // Store creation and retrieval
  getStore(executionId: ExecutionId): ExecutionKVStore;

  // Execution lifecycle
  deleteExecution(executionId: ExecutionId): Promise<void>;
  listExecutions(): Promise<ExecutionId[]>;

  // Cleanup and maintenance
  cleanupExpired(maxAgeMs: number): Promise<ExecutionId[]>;
}

// Storage directory for executions
const EXECUTIONS_DIR = 'executions';

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
    try {
      return await StorageFS.readJson<T>(this.keyToPath(key));
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async write<T = unknown>(key: string, value: T): Promise<void> {
    const dir = path.join(EXECUTIONS_DIR, this.executionId);
    await StorageFS.ensureDir(dir);
    await StorageFS.writeJson(this.keyToPath(key), value);
  }

  async delete(key: string): Promise<void> {
    try {
      await StorageFS.delete(this.keyToPath(key));
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return; // Already deleted, no-op
      }
      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    return StorageFS.exists(this.keyToPath(key));
  }

  async listKeys(prefix?: string): Promise<string[]> {
    const dir = path.join(EXECUTIONS_DIR, this.executionId);
    try {
      const entries = await StorageFS.readDir(dir);
      return entries
        .filter(([name, type]) => {
          if (!isFile(type) || !name.endsWith('.json')) return false;
          const key = name.replace(/\.json$/, '');
          return !prefix || key.startsWith(prefix);
        })
        .map(([name]) => name.replace(/\.json$/, ''));
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return []; // Directory doesn't exist yet
      }
      throw error;
    }
  }

  async clear(): Promise<void> {
    const dir = path.join(EXECUTIONS_DIR, this.executionId);
    try {
      await StorageFS.delete(dir);
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return; // Already cleared
      }
      throw error;
    }
  }

  getExecutionId(): ExecutionId {
    return this.executionId;
  }
}

/**
 * Default registry implementation using StorageFS.
 */
class StorageFSRegistry implements ExecutionStorageRegistry {
  private readonly stores = new Map<ExecutionId, ExecutionKVStore>();

  getStore(executionId: ExecutionId): ExecutionKVStore {
    let store = this.stores.get(executionId);
    if (!store) {
      store = new StorageFSKVStore(executionId);
      this.stores.set(executionId, store);
    }
    return store;
  }

  async deleteExecution(executionId: ExecutionId): Promise<void> {
    const store = this.stores.get(executionId);
    if (store) {
      await store.clear();
      this.stores.delete(executionId);
    } else {
      // Still try to delete from disk even if not cached
      const dir = path.join(EXECUTIONS_DIR, executionId);
      try {
        await StorageFS.delete(dir);
      } catch (error) {
        if (isFileNotFoundError(error)) {
          return;
        }
        throw error;
      }
    }
  }

  async listExecutions(): Promise<ExecutionId[]> {
    try {
      const entries = await StorageFS.readDir(EXECUTIONS_DIR);
      return entries
        .filter(([, type]) => isDirectory(type))
        .map(([name]) => name as ExecutionId);
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return [];
      }
      throw error;
    }
  }

  async cleanupExpired(maxAgeMs: number): Promise<ExecutionId[]> {
    const cutoff = Date.now() - maxAgeMs;
    const executions = await this.listExecutions();
    const deleted: ExecutionId[] = [];

    for (const executionId of executions) {
      const mtime = await this.getExecutionMtime(executionId);
      if (mtime !== null && mtime <= cutoff) {
        await this.deleteExecution(executionId);
        deleted.push(executionId);
      }
    }

    return deleted;
  }

  /**
   * Get the mtime of an execution, trying metadata first then directory.
   * Returns null if mtime cannot be determined.
   */
  private async getExecutionMtime(
    executionId: ExecutionId,
  ): Promise<number | null> {
    const metadataPath = path.join(
      EXECUTIONS_DIR,
      executionId,
      '.metadata.json',
    );
    try {
      const stats = await StorageFS.stat(metadataPath);
      return stats.mtime;
    } catch {
      // Metadata doesn't exist, fall back to directory mtime
    }

    try {
      const dirPath = path.join(EXECUTIONS_DIR, executionId);
      const stats = await StorageFS.stat(dirPath);
      return stats.mtime;
    } catch {
      return null; // Cannot determine mtime
    }
  }
}

// Singleton registry instance
let registryInstance: ExecutionStorageRegistry | null = null;

/**
 * Get the global ExecutionStorageRegistry instance.
 * Uses StorageFS backend by default.
 */
function getExecutionRegistry(): ExecutionStorageRegistry {
  if (!registryInstance) {
    registryInstance = new StorageFSRegistry();
  }
  return registryInstance;
}

/**
 * Convenience function to get a store for an execution.
 */
export function getExecutionStore(executionId: ExecutionId): ExecutionKVStore {
  return getExecutionRegistry().getStore(executionId);
}
