/**
 * Execution-scoped key-value store infrastructure.
 *
 * Provides a unified storage interface for all execution-scoped data,
 * including typed accessors for well-known keys (meta, config, todos, etc.)
 * and generic read/write for arbitrary keys.
 */

import { LRUCache } from 'lru-cache';
import { z } from 'zod';

import { resolveRunStoragePath } from '@platform/defaults/workspaceStorage';
import {
  type AgentConfig,
  AgentConfigSchema,
} from '@agent/core/definition/AgentConfig';
import {
  normalizeProviderMessages,
  ProviderMessageArraySchema,
} from '@agent/types/ProviderMessage';
import { KVStore } from '@common/storage/KVStore';
import * as logger from '@logger/logUtils';
import {
  ExecutionIdSchema,
  RunOutcomeSchema,
  StreamTabIdSchema,
  executionStatusToRunOutcome,
  type ExecutionId,
  type RunOutcome,
} from '@shared/schemas';
import { byString, filterNotNull, normalizeFilePath } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  parsePersistedResultMeta,
  ResultMetaSchema,
  type ResultMeta,
} from './resultMeta';

// ============================================================================
// Key constants (implementation detail — not exported)
// ============================================================================

/** Prefix for a per-child execution record's KV key. */
const CHILD_KEY_PREFIX = 'child-';

const SINGLE_VALUE_KEYS = {
  META: 'meta',
  CONFIG: 'config',
  REPORT: 'report',
  TODOS: 'todos',
  CONVERSATION: 'conversation',
  WORKSPACE_FILES: 'workspace-files',
  RESULT_META: 'result-meta',
  /** Cross-process liveness heartbeat; owned by executionLiveness.ts. */
  HEARTBEAT: 'heartbeat',
} as const;

const KEYS = {
  ...SINGLE_VALUE_KEYS,
  child: (id: string) => `${CHILD_KEY_PREFIX}${id}`,
} as const;

/** Single-value keys, derived from SINGLE_VALUE_KEYS so the reserved-name check below never drifts. */
const RESERVED_KEY_NAMES = new Set<string>(Object.values(SINGLE_VALUE_KEYS));

/**
 * True when `key` is one of ExecutionKVStore's reserved keys — a single-value
 * key (meta, config, report, todos, conversation, workspace-files,
 * result-meta) or a per-child record key (`child-{id}`). Exported so callers
 * that walk an execution's storage directory (e.g.
 * `src/tools/executions/executionKvFiles.ts`) can recognize internal KV
 * entries without re-deriving this vocabulary themselves.
 */
export function isReservedKvKeyName(key: string): boolean {
  return RESERVED_KEY_NAMES.has(key) || key.startsWith(CHILD_KEY_PREFIX);
}

const CHANNEL = 'ExecutionKVStore';
export const EXECUTION_META_SCHEMA_VERSION = 1;

// ============================================================================
// Domain types — Zod schemas as source of truth
// ============================================================================

/** Execution metadata stored alongside config at launch time. */
const ExecutionMetaBaseSchema = z.object({
  schemaVersion: z.literal(EXECUTION_META_SCHEMA_VERSION).prefault(1),
  timestamp: z.string(),
  parentExecutionId: ExecutionIdSchema.optional(),
  /** Persisted when execution reaches a terminal state (success or error). */
  terminalStatus: z.string().optional(),
  /** Canonical terminal outcome; legacy meta files derive this from terminalStatus. */
  outcome: RunOutcomeSchema.optional(),
  /** Runtime category override (e.g. 'process' for background bash). */
  category: z.string().optional(),
  /** AI-generated summary of what the session aimed to accomplish. */
  description: z.string().optional(),
  /**
   * The transcript stream this execution's data lives under, once resolved.
   * Decide-once-carry-as-data cache for `resolvePersistedStreamIdForExecution`
   * (`executionStreamResolver.ts`): absent on executions whose stream wasn't
   * resolved yet (or predate this field), in which case the resolver falls
   * back to its full meta-scan.
   */
  streamId: StreamTabIdSchema.optional(),
});

export const ExecutionMetaSchema = ExecutionMetaBaseSchema.transform(
  (
    meta,
  ): z.infer<typeof ExecutionMetaBaseSchema> & { outcome?: RunOutcome } => {
    const outcome =
      meta.outcome ?? executionStatusToRunOutcome(meta.terminalStatus);
    return outcome ? { ...meta, outcome } : meta;
  },
);
export type ExecutionMeta = z.infer<typeof ExecutionMetaSchema>;
export type ExecutionMetaInput = z.input<typeof ExecutionMetaSchema>;

/** Shape of a persisted todo item from tool-use flow state. */
const TodoEntrySchema = z.object({
  content: z.string().optional(),
  status: z.string().optional(),
});
export type TodoEntry = z.infer<typeof TodoEntrySchema>;

const TodoArraySchema = z.array(TodoEntrySchema);
const WorkspaceFilePathArraySchema = z.array(z.string());

/** Stored data for a child execution record (without the derived `id` field). */
const ChildRecordDataSchema = z.object({
  agent: z.string(),
  timestamp: z.string(),
});
type ChildRecordData = z.infer<typeof ChildRecordDataSchema>;

/** Full child record including the `id` derived from the KV key name. */
export interface ChildRecord extends ChildRecordData {
  id: ExecutionId;
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
  /**
   * Last-modified time (ms since epoch) of the legacy `todos.json`, or
   * `undefined` when it has never been written. Lets callers compare
   * freshness against a durable sidecar written by a different store.
   */
  todosModifiedAt(): Promise<number | undefined>;
  readConversation(): Promise<unknown[] | null>;
  /** Same freshness accessor as {@link todosModifiedAt}, for `conversation.json`. */
  conversationModifiedAt(): Promise<number | undefined>;
  readWorkspaceFiles(): Promise<string[]>;
  readChildren(): Promise<ChildRecord[]>;
  readResultMeta(): Promise<ResultMeta | null>;

  // -- Typed writers --------------------------------------------------------
  writeMeta(meta: ExecutionMetaInput): Promise<void>;
  writeConfig(config: AgentConfig): Promise<void>;
  writeReport(report: string): Promise<void>;
  writeTodos(todos: TodoEntry[]): Promise<void>;
  writeConversation(messages: unknown[]): Promise<void>;
  writeWorkspaceFiles(paths: readonly string[]): Promise<void>;
  writeChild(childId: ExecutionId, data: ChildRecordData): Promise<void>;
  writeResultMeta(data: ResultMeta): Promise<void>;
}

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
    super(resolveRunStoragePath(executionId), { throwOnErrors: true });
  }

  async clear(): Promise<void> {
    return this.deleteDir();
  }

  getExecutionId(): ExecutionId {
    return this.executionId;
  }

  // -- Typed readers --------------------------------------------------------

  /**
   * Read a key and validate it against a schema, returning the parsed value
   * or `null` when the key is absent or fails validation. Single source of
   * truth for the read-validate-or-null policy shared by the typed readers
   * below. A missing file is the expected case and stays quiet; a present
   * value that fails validation is a loud read (#6966 bullet 5) — corrupt is
   * never silently conflated with missing (#7210 pattern).
   */
  private async readValidated<T>(
    key: string,
    schema: z.ZodType<T>,
  ): Promise<T | null> {
    const raw = await this.read(key);
    if (raw == null) return null;
    const result = schema.nullable().safeParse(raw);
    if (result.success) return result.data;
    logger.warn(
      CHANNEL,
      `Failed to parse execution ${this.executionId} ${key}.json: ${toErrorMessage(
        result.error,
      )}`,
      { data: result.error },
    );
    return null;
  }

  async readMeta(): Promise<ExecutionMeta | null> {
    return this.readValidated(KEYS.META, ExecutionMetaSchema);
  }

  async readConfig(): Promise<AgentConfig | null> {
    return this.readValidated<AgentConfig>(KEYS.CONFIG, AgentConfigSchema);
  }

  async readReport(): Promise<string | null> {
    return (await this.read<string>(KEYS.REPORT)) ?? null;
  }

  async readTodos(): Promise<TodoEntry[]> {
    return (await this.readValidated(KEYS.TODOS, TodoArraySchema)) ?? [];
  }

  async todosModifiedAt(): Promise<number | undefined> {
    return this.modifiedAt(KEYS.TODOS);
  }

  async readConversation(): Promise<unknown[] | null> {
    const raw = await this.read(KEYS.CONVERSATION);
    if (raw == null) return null;
    const messages = normalizeProviderMessages(raw);
    if (messages === null) {
      logger.warn(
        CHANNEL,
        `Failed to parse execution ${this.executionId} ${KEYS.CONVERSATION}.json as provider messages`,
      );
      return null;
    }
    return messages.length > 0 ? messages : null;
  }

  async conversationModifiedAt(): Promise<number | undefined> {
    return this.modifiedAt(KEYS.CONVERSATION);
  }

  async readWorkspaceFiles(): Promise<string[]> {
    const paths =
      (await this.readValidated(
        KEYS.WORKSPACE_FILES,
        WorkspaceFilePathArraySchema,
      )) ?? [];
    return normalizeWorkspaceFilePaths(paths);
  }

  /** Read children: per-child KV keys with schema validation. */
  async readChildren(): Promise<ChildRecord[]> {
    const childKeys = await this.listKeys(CHILD_KEY_PREFIX);

    if (childKeys.length === 0) return [];

    const entries = await Promise.all(
      childKeys.map(async (key) => {
        const id = key.replace(CHILD_KEY_PREFIX, '') as ExecutionId;
        const raw = await this.read(key);
        const result = ChildRecordDataSchema.safeParse(raw);
        return result.success ? { id, ...result.data } : null;
      }),
    );
    return entries.filter(filterNotNull);
  }

  async readResultMeta(): Promise<ResultMeta | null> {
    const raw = await this.read(KEYS.RESULT_META);
    if (raw == null) return null;

    const canonical = ResultMetaSchema.safeParse(raw);
    if (canonical.success) return canonical.data;

    const [meta, config] = await Promise.all([
      this.readMeta(),
      this.readConfig(),
    ]);
    try {
      return parsePersistedResultMeta(raw, {
        category: config?.agentCategory,
        outcome: meta?.outcome,
      });
    } catch (error) {
      logger.warn(
        CHANNEL,
        `Failed to parse execution ${this.executionId} ${KEYS.RESULT_META}.json: ${toErrorMessage(error)}`,
        { data: error },
      );
      return null;
    }
  }

  // -- Typed writers --------------------------------------------------------

  async writeMeta(meta: ExecutionMetaInput): Promise<void> {
    await this.write(KEYS.META, ExecutionMetaSchema.parse(meta));
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
    await this.write(
      KEYS.CONVERSATION,
      ProviderMessageArraySchema.parse(messages),
    );
  }

  async writeWorkspaceFiles(paths: readonly string[]): Promise<void> {
    await this.write(KEYS.WORKSPACE_FILES, normalizeWorkspaceFilePaths(paths));
  }

  async writeChild(childId: ExecutionId, data: ChildRecordData): Promise<void> {
    await this.write(KEYS.child(childId), data);
  }

  async writeResultMeta(data: ResultMeta): Promise<void> {
    await this.write(KEYS.RESULT_META, ResultMetaSchema.parse(data));
  }
}

function normalizeWorkspaceFilePaths(paths: readonly string[]): string[] {
  const normalized = new Set<string>();
  for (const rawPath of paths) {
    const pathValue = normalizeFilePath(rawPath.trim());
    if (pathValue) normalized.add(pathValue);
  }
  return [...normalized].sort(byString);
}

// ============================================================================
// Factory
// ============================================================================

// LRU-capped store cache. StorageFSKVStore is stateless (file-backed),
// so eviction is lossless — re-creation just makes a new thin wrapper.
const storeCache = new LRUCache<ExecutionId, ExecutionKVStore>({ max: 50 });

export function getExecutionStore(executionId: ExecutionId): ExecutionKVStore {
  const cached = storeCache.get(executionId);
  if (cached) return cached;

  const store = new StorageFSKVStore(executionId);
  storeCache.set(executionId, store);
  return store;
}

/** Clear the in-memory store cache. Called during extension deactivation. */
export function clearStoreCache(): void {
  storeCache.clear();
}
