/**
 * Execution-scoped key-value store infrastructure.
 *
 * Provides a unified storage interface for all execution-scoped data,
 * including typed accessors for well-known keys (meta, config, todos, etc.)
 * and generic read/write for arbitrary keys.
 */

import * as path from 'path';

import type { AgentConfig } from '@agent/core/AgentConfig';
import { isFileNotFoundError } from '@common/errors';
import { isFile } from '@common/files/fsEntryType';
import { StorageFS } from '@utils/files';
import { hasExtension } from '@utils/core/pathCore';

import type { ExecutionId } from '@shared/schemas';

// ============================================================================
// Domain types
// ============================================================================

/** Execution metadata stored alongside config at launch time. */
export interface ExecutionMeta {
  timestamp: string;
  parentExecutionId?: ExecutionId;
  /** Persisted when execution reaches a terminal state (success or error). */
  terminalStatus?: string;
  /** Runtime category override (e.g. 'process' for background bash). */
  category?: string;
}

/** Shape of a persisted todo item from tool-use flow state. */
export interface TodoEntry {
  content?: string;
  status?: string;
}

/** Shape of a child execution record stored as `child-{id}` on the parent. */
export interface ChildRecord {
  id: ExecutionId;
  agent: string;
  timestamp: string;
}

// ============================================================================
// Interface
// ============================================================================

/**
 * Execution-scoped key-value store.
 *
 * All keys are automatically namespaced to the execution context.
 * Values are JSON-serialized transparently.
 *
 * Typed accessors (readMeta, readConfig, etc.) provide domain-specific
 * reads with backward-compatibility fallbacks where needed.
 */
export interface ExecutionKVStore {
  // -- Generic KV -----------------------------------------------------------
  read<T = unknown>(key: string): Promise<T | undefined>;
  write<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  listKeys(prefix?: string): Promise<string[]>;
  clear(): Promise<void>;
  getExecutionId(): ExecutionId;

  // -- Typed readers --------------------------------------------------------
  readMeta(): Promise<ExecutionMeta | null>;
  readConfig(): Promise<AgentConfig | null>;
  readReport(): Promise<string | null>;
  readTodos(): Promise<TodoEntry[]>;
  readConversation(): Promise<unknown[] | null>;
  readChildren(): Promise<ChildRecord[]>;

}

/**
 * Storage directory for all execution data (KV, output logs, etc.).
 * This matches TASK_RUNS_DIR by design — both point to 'executions/' so
 * KV metadata and workflow output files share the same per-execution directory.
 */
export const EXECUTIONS_DIR = 'executions';

// ============================================================================
// Helpers
// ============================================================================

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

function jsonFileToKey(filename: string): string {
  return filename.replace(/\.json$/, '');
}

// ============================================================================
// Implementation
// ============================================================================

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

  // -- Generic KV -----------------------------------------------------------

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
        if (!isFile(type) || !hasExtension(name, '.json')) return false;
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

  // -- Typed readers --------------------------------------------------------

  async readMeta(): Promise<ExecutionMeta | null> {
    const direct = await this.read<ExecutionMeta>('meta');
    if (direct?.timestamp) return direct;
    return null;
  }

  async readConfig(): Promise<AgentConfig | null> {
    return (await this.read<AgentConfig>('config')) ?? null;
  }

  async readReport(): Promise<string | null> {
    return (await this.read<string>('report')) ?? null;
  }

  /** Read todo items: direct key first, flow blob fallback. */
  async readTodos(): Promise<TodoEntry[]> {
    const direct = await this.read<TodoEntry[]>('todos');
    if (Array.isArray(direct) && direct.length > 0) return direct;

    // Fallback: extract from flow blob (backward compat / running executions)
    const flow = await this.read<{
      shared?: {
        stateSlices?: {
          workspaceSnapshot?: { todos?: { todos?: unknown[] } };
        };
      };
    }>(`flow:${this.executionId}`);

    const raw = flow?.shared?.stateSlices?.workspaceSnapshot?.todos?.todos;
    if (!Array.isArray(raw) || raw.length === 0) return [];
    return raw as TodoEntry[];
  }

  /** Read conversation messages: direct key first, flow blob fallback. */
  async readConversation(): Promise<unknown[] | null> {
    const direct = await this.read<unknown[]>('conversation');
    if (Array.isArray(direct) && direct.length > 0) return direct;

    // Fallback: extract from flow blob (backward compat / running executions)
    const flow = await this.read<{
      shared?: { conversation?: unknown[]; messages?: unknown[] };
    }>(`flow:${this.executionId}`);
    return flow?.shared?.conversation ?? flow?.shared?.messages ?? null;
  }

  /** Read children: per-child KV keys. */
  async readChildren(): Promise<ChildRecord[]> {
    const childKeys = await this.listKeys('child-');

    if (childKeys.length === 0) return [];

    const entries = await Promise.all(
      childKeys.map(async (key) => {
        const id = key.replace('child-', '') as ExecutionId;
        const data = await this.read<{ agent: string; timestamp: string }>(key);
        return data ? { id, agent: data.agent, timestamp: data.timestamp } : null;
      }),
    );
    return entries.filter((e): e is ChildRecord => e !== null);
  }

}

// ============================================================================
// Factory
// ============================================================================

// Cached stores for reuse
const storeCache = new Map<ExecutionId, ExecutionKVStore>();

export function getExecutionStore(executionId: ExecutionId): ExecutionKVStore {
  const cached = storeCache.get(executionId);
  if (cached) return cached;

  const store = new StorageFSKVStore(executionId);
  storeCache.set(executionId, store);
  return store;
}
