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
import { KVStore } from '@common/storage/KVStore';
import * as logger from '@logger/logUtils';
import {
  ExecutionIdSchema,
  RunOutcomeSchema,
  executionStatusToRunOutcome,
  type ExecutionId,
  type RunOutcome,
} from '@shared/schemas';
import { normalizeFilePath } from '@shared/utils/path';
import {
  CompileFailureSummarySchema,
  OutputFileSummarySchema,
} from '@shared/schemas/output';
import { byString, filterNotNull } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

// ============================================================================
// Key constants (implementation detail — not exported)
// ============================================================================

const KEYS = {
  META: 'meta',
  CONFIG: 'config',
  REPORT: 'report',
  TODOS: 'todos',
  CONVERSATION: 'conversation',
  WORKSPACE_FILES: 'workspace-files',
  RESULT_META: 'result-meta',
  child: (id: string) => `child-${id}`,
} as const;

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
   * Delegation depth at launch time: 0 for user-initiated, N for an agent
   * N levels deep. Optional so pre-feature snapshots don't fail validation.
   * Read on resume to enforce the nested-delegation cap without having to
   * walk a potentially broken parent chain.
   */
  delegationDepth: z.int().nonnegative().optional(),
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

const TodoArraySchema = z.array(TodoEntrySchema).catch([]);
const WorkspaceFilePathArraySchema = z.array(z.string()).catch([]);

/** Stored data for a child execution record (without the derived `id` field). */
const ChildRecordDataSchema = z.object({
  agent: z.string(),
  timestamp: z.string(),
});
export type ChildRecordData = z.infer<typeof ChildRecordDataSchema>;

/** Full child record including the `id` derived from the KV key name. */
export interface ChildRecord extends ChildRecordData {
  id: ExecutionId;
}

/** Line-diff reference for one output file, relative to the run directory. */
const ResultDiffSummarySchema = z.object({
  /** Absolute path of the output file the diff belongs to. */
  path: z.string(),
  /** Diff file path relative to the execution run directory. */
  diffRelPath: z.string(),
  /** True when the change ratio exceeded the large-change threshold. */
  largeChange: z.boolean(),
});

/**
 * Structured result of a finished execution — the machine-readable
 * counterpart of the prose report. This is the chaining contract: a later
 * stage (orchestrator or workflow script) reads outputs/diffs/outcome as
 * data instead of parsing the XML delivery. Written by subagent completion,
 * background bash, and CLI workflow runs; all fields optional so each
 * writer contributes what it has.
 */
export const ResultMetaSchema = z.object({
  exitCode: z.int().optional(),
  wallTimeMs: z.number().nonnegative().optional(),
  success: z.boolean().optional(),
  timedOut: z.boolean().optional(),
  command: z.string().optional(),
  copiedOutput: z.string().optional(),
  copiedOutputs: z.array(z.string()).optional(),
  outputs: z.array(OutputFileSummarySchema).optional(),
  compileFailures: z.array(CompileFailureSummarySchema).optional(),
  /** Agent that produced this result (subagent completions). */
  agentName: z.string().optional(),
  // New agent categories must be added here, or their manifests fail
  // validation on read and surface as null.
  category: z.enum(['workflow', 'toolUse']).optional(),
  outcome: RunOutcomeSchema.optional(),
  /** Final assistant text (tool-use agents). */
  lastResponse: z.string().optional(),
  /** Workspace-relative paths touched by a tool-use run. */
  touchedFiles: z.array(z.string()).optional(),
  /** Total model cost (USD) including the run's own subagents. */
  totalCostUsd: z.number().nonnegative().optional(),
  /** Line-diff files written for workflow outputs. */
  diffs: z.array(ResultDiffSummarySchema).optional(),
  /**
   * Present when diff generation failed for a workflow result: carries the
   * error so a chaining consumer distinguishes "diffs failed, read the
   * output files directly" from a genuine no-diff/clean result.
   */
  diffsUnavailable: z.string().optional(),
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
    super(resolveRunStoragePath(executionId));
  }

  async clear(): Promise<void> {
    return this.deleteDir();
  }

  getExecutionId(): ExecutionId {
    return this.executionId;
  }

  // -- Typed readers --------------------------------------------------------

  /**
   * Read a key and validate it against a schema, returning the parsed value or
   * `null` when the key is absent or fails validation. Single source of truth
   * for the read-validate-or-null policy shared by the typed readers below.
   */
  private async readValidated<T>(
    key: string,
    schema: z.ZodType<T>,
    options: { warnOnFailure?: boolean } = {},
  ): Promise<T | null> {
    const raw = await this.read(key);
    if (raw == null) return null;
    const result = schema.nullable().safeParse(raw);
    if (result.success) return result.data;
    if (options.warnOnFailure) {
      logger.warn(
        CHANNEL,
        `Failed to parse execution ${this.executionId} ${key}.json: ${toErrorMessage(
          result.error,
        )}`,
        { data: result.error },
      );
    }
    return null;
  }

  async readMeta(): Promise<ExecutionMeta | null> {
    return this.readValidated(KEYS.META, ExecutionMetaSchema, {
      warnOnFailure: true,
    });
  }

  async readConfig(): Promise<AgentConfig | null> {
    return this.readValidated<AgentConfig>(KEYS.CONFIG, AgentConfigSchema);
  }

  async readReport(): Promise<string | null> {
    return (await this.read<string>(KEYS.REPORT)) ?? null;
  }

  async readTodos(): Promise<TodoEntry[]> {
    return TodoArraySchema.parse(await this.read<unknown[]>(KEYS.TODOS));
  }

  async readConversation(): Promise<unknown[] | null> {
    const raw = await this.read<unknown[]>(KEYS.CONVERSATION);
    return Array.isArray(raw) && raw.length > 0 ? raw : null;
  }

  async readWorkspaceFiles(): Promise<string[]> {
    const raw = await this.read(KEYS.WORKSPACE_FILES);
    return normalizeWorkspaceFilePaths(WorkspaceFilePathArraySchema.parse(raw));
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
    return entries.filter(filterNotNull);
  }

  async readResultMeta(): Promise<ResultMeta | null> {
    return this.readValidated(KEYS.RESULT_META, ResultMetaSchema);
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
    await this.write(KEYS.CONVERSATION, messages);
  }

  async writeWorkspaceFiles(paths: readonly string[]): Promise<void> {
    await this.write(KEYS.WORKSPACE_FILES, normalizeWorkspaceFilePaths(paths));
  }

  async writeChild(childId: ExecutionId, data: ChildRecordData): Promise<void> {
    await this.write(KEYS.child(childId), data);
  }

  async writeResultMeta(data: ResultMeta): Promise<void> {
    await this.write(KEYS.RESULT_META, data);
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
