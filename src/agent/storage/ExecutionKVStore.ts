/**
 * Execution-scoped key-value store infrastructure.
 *
 * Provides a unified storage interface for all execution-scoped data,
 * including typed accessors for well-known keys (meta, config, todos, etc.)
 * and generic read/write for arbitrary keys.
 */

import * as path from 'path';

import { z } from 'zod';

import { type AgentConfig, AgentConfigSchema } from '@agent/core/AgentConfig';
import { KVStore } from '@common/storage/KVStore';
import { ExecutionIdSchema, type ExecutionId } from '@shared/schemas';

// ============================================================================
// Key constants (implementation detail — not exported)
// ============================================================================

const KEYS = {
  META: 'meta',
  CONFIG: 'config',
  REPORT: 'report',
  TODOS: 'todos',
  CONVERSATION: 'conversation',
  RESULT_META: 'result-meta',
  child: (id: string) => `child-${id}`,
} as const;

// ============================================================================
// Domain types — Zod schemas as source of truth
// ============================================================================

/** Execution metadata stored alongside config at launch time. */
export const ExecutionMetaSchema = z.object({
  timestamp: z.string(),
  parentExecutionId: ExecutionIdSchema.optional(),
  /** Persisted when execution reaches a terminal state (success or error). */
  terminalStatus: z.string().optional(),
  /** Runtime category override (e.g. 'process' for background bash). */
  category: z.string().optional(),
  /** AI-generated summary of what the session aimed to accomplish. */
  description: z.string().optional(),
  /**
   * Delegation depth at launch time: 0 for user-initiated, N for an agent
   * N levels deep. Optional so pre-feature snapshots don't fail validation.
   * Read on resume to enforce the nested-delegation cap without having to
   * walk a potentially broken parent chain.
   */
  delegationDepth: z.int().nonnegative().optional(),
});
export type ExecutionMeta = z.infer<typeof ExecutionMetaSchema>;

/** Shape of a persisted todo item from tool-use flow state. */
export const TodoEntrySchema = z.object({
  content: z.string().optional(),
  status: z.string().optional(),
});
export type TodoEntry = z.infer<typeof TodoEntrySchema>;

const TodoArraySchema = z.array(TodoEntrySchema);

/** Parse a raw array into validated TodoEntry[]. Returns empty on failure. */
function parseTodoArray(raw: unknown[]): TodoEntry[] {
  const result = TodoArraySchema.safeParse(raw);
  return result.success ? result.data : [];
}

/** Stored data for a child execution record (without the derived `id` field). */
export const ChildRecordDataSchema = z.object({
  agent: z.string(),
  timestamp: z.string(),
});
export type ChildRecordData = z.infer<typeof ChildRecordDataSchema>;

/** Full child record including the `id` derived from the KV key name. */
export interface ChildRecord extends ChildRecordData {
  id: ExecutionId;
}

/** Result metadata for background bash processes. */
export const ResultMetaSchema = z.object({
  exitCode: z.int().optional(),
  wallTimeMs: z.number().nonnegative().optional(),
  success: z.boolean().optional(),
  timedOut: z.boolean().optional(),
  command: z.string().optional(),
});
export type ResultMeta = z.infer<typeof ResultMetaSchema>;

// ============================================================================
// Interface
// ============================================================================

/**
 * Execution-scoped key-value store.
 *
 * All keys are automatically namespaced to the execution context.
 * Values are JSON-serialized transparently.
 *
 * Typed accessors provide domain-specific reads with schema validation;
 * malformed or missing entries resolve to null.
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
  readResultMeta(): Promise<ResultMeta | null>;

  // -- Typed writers --------------------------------------------------------
  writeMeta(meta: ExecutionMeta): Promise<void>;
  writeConfig(config: AgentConfig): Promise<void>;
  writeReport(report: string): Promise<void>;
  writeTodos(todos: TodoEntry[]): Promise<void>;
  writeConversation(messages: unknown[]): Promise<void>;
  writeChild(childId: ExecutionId, data: ChildRecordData): Promise<void>;
  writeResultMeta(data: ResultMeta): Promise<void>;
}

/**
 * Storage directory for all execution data (KV, output logs, etc.).
 * This matches TASK_RUNS_DIR by design — both point to 'executions/' so
 * KV metadata and workflow output files share the same per-execution directory.
 */
export const EXECUTIONS_DIR = 'executions';

// ============================================================================
// Implementation
// ============================================================================

/**
 * StorageFS-backed implementation of ExecutionKVStore.
 * Extends KVStore for generic file operations and adds typed accessors.
 * Stores data in executions/{executionId}/{key}.json
 */
class StorageFSKVStore extends KVStore implements ExecutionKVStore {
  constructor(private readonly executionId: ExecutionId) {
    super(path.join(EXECUTIONS_DIR, executionId));
  }

  async clear(): Promise<void> {
    return this.deleteDir();
  }

  getExecutionId(): ExecutionId {
    return this.executionId;
  }

  // -- Typed readers --------------------------------------------------------

  async readMeta(): Promise<ExecutionMeta | null> {
    const raw = await this.read(KEYS.META);
    if (!raw) return null;
    const result = ExecutionMetaSchema.safeParse(raw);
    return result.success ? result.data : null;
  }

  async readConfig(): Promise<AgentConfig | null> {
    const raw = await this.read(KEYS.CONFIG);
    if (!raw) return null;
    const result = AgentConfigSchema.safeParse(raw);
    return result.success ? result.data : null;
  }

  async readReport(): Promise<string | null> {
    return (await this.read<string>(KEYS.REPORT)) ?? null;
  }

  async readTodos(): Promise<TodoEntry[]> {
    const raw = await this.read<unknown[]>(KEYS.TODOS);
    if (!Array.isArray(raw) || raw.length === 0) return [];
    return parseTodoArray(raw);
  }

  async readConversation(): Promise<unknown[] | null> {
    const raw = await this.read<unknown[]>(KEYS.CONVERSATION);
    return Array.isArray(raw) && raw.length > 0 ? raw : null;
  }

  /** Read children: per-child KV keys with schema validation. */
  async readChildren(): Promise<ChildRecord[]> {
    const childKeys = await this.listKeys('child-');

    if (childKeys.length === 0) return [];

    const entries = await Promise.all(
      childKeys.map(async (key) => {
        const id = key.replace('child-', '') as ExecutionId;
        const raw = await this.read(key);
        const result = ChildRecordDataSchema.safeParse(raw);
        return result.success ? { id, ...result.data } : null;
      }),
    );
    return entries.filter((e): e is ChildRecord => e !== null);
  }

  async readResultMeta(): Promise<ResultMeta | null> {
    const raw = await this.read(KEYS.RESULT_META);
    if (!raw) return null;
    const result = ResultMetaSchema.safeParse(raw);
    return result.success ? result.data : null;
  }

  // -- Typed writers --------------------------------------------------------

  async writeMeta(meta: ExecutionMeta): Promise<void> {
    await this.write(KEYS.META, meta);
  }

  async writeConfig(config: AgentConfig): Promise<void> {
    await this.write(KEYS.CONFIG, config);
  }

  async writeReport(report: string): Promise<void> {
    await this.write(KEYS.REPORT, report);
  }

  async writeTodos(todos: TodoEntry[]): Promise<void> {
    await this.write(KEYS.TODOS, todos);
  }

  async writeConversation(messages: unknown[]): Promise<void> {
    await this.write(KEYS.CONVERSATION, messages);
  }

  async writeChild(childId: ExecutionId, data: ChildRecordData): Promise<void> {
    await this.write(KEYS.child(childId), data);
  }

  async writeResultMeta(data: ResultMeta): Promise<void> {
    await this.write(KEYS.RESULT_META, data);
  }
}

// ============================================================================
// Factory
// ============================================================================

// LRU-capped store cache. StorageFSKVStore is stateless (file-backed),
// so eviction is lossless — re-creation just makes a new thin wrapper.
const MAX_STORE_CACHE_SIZE = 50;
const storeCache = new Map<ExecutionId, ExecutionKVStore>();

export function getExecutionStore(executionId: ExecutionId): ExecutionKVStore {
  const cached = storeCache.get(executionId);
  if (cached) {
    // Move to end (most-recently used)
    storeCache.delete(executionId);
    storeCache.set(executionId, cached);
    return cached;
  }

  if (storeCache.size >= MAX_STORE_CACHE_SIZE) {
    const oldest = storeCache.keys().next().value;
    if (oldest !== undefined) storeCache.delete(oldest);
  }

  const store = new StorageFSKVStore(executionId);
  storeCache.set(executionId, store);
  return store;
}

/** Clear the in-memory store cache. Called during extension deactivation. */
export function clearStoreCache(): void {
  storeCache.clear();
}
