/**
 * Execution-scoped key-value store infrastructure.
 *
 * This module provides a unified storage interface for all execution-scoped data,
 * replacing the fragmented TaskRunFileService and ToolUseSnapshotStore patterns.
 *
 * Architecture:
 * - ExecutionKVStore: Consumer-facing interface, auto-scoped to execution
 * - ExecutionStorageRegistry: Factory and lifecycle manager
 * - StorageFSKVStore: VS Code storage backend
 * - InMemoryKVStore: Testing backend
 */

import * as path from 'path';

import * as vscode from 'vscode';

import type { ExecutionId } from '@agent/types/IdentifierTypes';

import { StorageFS } from '@utils/files';

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
    const sanitized = key.replace(/\.\./g, '_').replace(/[<>:"|?*]/g, '_');
    return path.join(EXECUTIONS_DIR, this.executionId, `${sanitized}.json`);
  }

  async read<T = unknown>(key: string): Promise<T | undefined> {
    try {
      return await StorageFS.readJson<T>(this.keyToPath(key));
    } catch (error) {
      if (
        error instanceof vscode.FileSystemError &&
        error.code === 'FileNotFound'
      ) {
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
      if (
        error instanceof vscode.FileSystemError &&
        error.code === 'FileNotFound'
      ) {
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
          if (type !== vscode.FileType.File) return false;
          if (!name.endsWith('.json')) return false;
          const key = name.replace(/\.json$/, '');
          return !prefix || key.startsWith(prefix);
        })
        .map(([name]) => name.replace(/\.json$/, ''));
    } catch (error) {
      if (
        error instanceof vscode.FileSystemError &&
        error.code === 'FileNotFound'
      ) {
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
      if (
        error instanceof vscode.FileSystemError &&
        error.code === 'FileNotFound'
      ) {
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
 * In-memory implementation of ExecutionKVStore for testing.
 * No VS Code dependencies, pure Node.js.
 */
export class InMemoryKVStore implements ExecutionKVStore {
  private readonly store = new Map<string, unknown>();

  constructor(private readonly executionId: ExecutionId) {}

  async read<T = unknown>(key: string): Promise<T | undefined> {
    const value = this.store.get(key);
    if (value === undefined) return undefined;
    // Use structuredClone to simulate serialization round-trip
    return structuredClone(value) as T;
  }

  async write<T = unknown>(key: string, value: T): Promise<void> {
    // Use structuredClone to simulate serialization
    this.store.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  async listKeys(prefix?: string): Promise<string[]> {
    return Array.from(this.store.keys()).filter(
      (k) => !prefix || k.startsWith(prefix),
    );
  }

  async clear(): Promise<void> {
    this.store.clear();
  }

  getExecutionId(): ExecutionId {
    return this.executionId;
  }

  // Test helper: get raw store size
  get size(): number {
    return this.store.size;
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
        if (
          error instanceof vscode.FileSystemError &&
          error.code === 'FileNotFound'
        ) {
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
        .filter(([, type]) => type === vscode.FileType.Directory)
        .map(([name]) => name as ExecutionId);
    } catch (error) {
      if (
        error instanceof vscode.FileSystemError &&
        error.code === 'FileNotFound'
      ) {
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
      const metadataPath = path.join(
        EXECUTIONS_DIR,
        executionId,
        '.metadata.json',
      );
      try {
        const stats = await StorageFS.stat(metadataPath);
        if (stats.mtime <= cutoff) {
          await this.deleteExecution(executionId);
          deleted.push(executionId);
        }
      } catch (error) {
        // If metadata doesn't exist, check directory mtime
        try {
          const dirPath = path.join(EXECUTIONS_DIR, executionId);
          const dirStats = await StorageFS.stat(dirPath);
          if (dirStats.mtime <= cutoff) {
            await this.deleteExecution(executionId);
            deleted.push(executionId);
          }
        } catch {
          // Skip if we can't stat the directory
        }
      }
    }

    return deleted;
  }
}

/**
 * In-memory registry for testing.
 */
export class InMemoryRegistry implements ExecutionStorageRegistry {
  private readonly stores = new Map<ExecutionId, InMemoryKVStore>();

  getStore(executionId: ExecutionId): ExecutionKVStore {
    let store = this.stores.get(executionId);
    if (!store) {
      store = new InMemoryKVStore(executionId);
      this.stores.set(executionId, store);
    }
    return store;
  }

  async deleteExecution(executionId: ExecutionId): Promise<void> {
    this.stores.delete(executionId);
  }

  async listExecutions(): Promise<ExecutionId[]> {
    return Array.from(this.stores.keys());
  }

  async cleanupExpired(_maxAgeMs: number): Promise<ExecutionId[]> {
    // In-memory stores don't track creation time, so no cleanup
    return [];
  }

  // Test helper: clear all stores
  clearAll(): void {
    this.stores.clear();
  }
}

// Singleton registry instance
let registryInstance: ExecutionStorageRegistry | null = null;

/**
 * Get the global ExecutionStorageRegistry instance.
 * Uses StorageFS backend by default.
 */
export function getExecutionRegistry(): ExecutionStorageRegistry {
  if (!registryInstance) {
    registryInstance = new StorageFSRegistry();
  }
  return registryInstance;
}

/**
 * Set a custom registry (for testing).
 */
export function setExecutionRegistry(
  registry: ExecutionStorageRegistry | null,
): void {
  registryInstance = registry;
}

/**
 * Convenience function to get a store for an execution.
 */
export function getExecutionStore(executionId: ExecutionId): ExecutionKVStore {
  return getExecutionRegistry().getStore(executionId);
}
