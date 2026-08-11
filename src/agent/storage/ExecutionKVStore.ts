/**
 * Execution-scoped key-value store infrastructure.
 *
 * Provides a unified storage interface for all execution-scoped data,
 * including typed accessors for well-known keys (meta, config, report, etc.)
 * and generic read/write for arbitrary keys.
 */

import { LRUCache } from 'lru-cache';
import { z } from 'zod';

import {
  type AgentConfig,
  AgentConfigSchema,
} from '@agent/core/definition/AgentConfig';
import {
  isAgentRunRecord,
  RunRecordSchema,
  type RunRecord,
} from '@agent/core/definition/RunRecord';
import { KVStore } from '@common/storage/KVStore';
import * as logger from '@logger/logUtils';
import { resolveRunStoragePath } from '@platform/defaults/workspaceStorage';
import {
  ExecutionMetaCoreSchema,
  ExecutionMetaSchema,
  WorkflowExecutionSnapshotSchema,
  type ExecutionId,
  type ExecutionMeta,
} from '@shared/schemas';
import { byString, filterNotNull, normalizeFilePath } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  applyExecutionOutcome,
  ResultMetaSchema,
  type ResultMeta,
} from './resultMeta';
import { runWithExecutionLeaseWriteFence } from './executionLease';

// ============================================================================
// Key constants (implementation detail — not exported)
// ============================================================================

/** Prefix for a per-child execution record's KV key. */
const CHILD_KEY_PREFIX = 'child-';

const SINGLE_VALUE_KEYS = {
  META: 'meta',
  CONFIG: 'config',
  REPORT: 'report',
  WORKSPACE_FILES: 'workspace-files',
  RESULT_META: 'result-meta',
  TURN_STATE: 'turn-state',
} as const;

const KEYS = {
  ...SINGLE_VALUE_KEYS,
  child: (id: string) => `${CHILD_KEY_PREFIX}${id}`,
} as const;

/** Single-value keys, derived from SINGLE_VALUE_KEYS so the reserved-name check below never drifts. */
const RESERVED_KEY_NAMES = new Set<string>(Object.values(SINGLE_VALUE_KEYS));

/**
 * True when `key` is one of ExecutionKVStore's reserved keys — a single-value
 * key (meta, config, report, workspace-files, result-meta) or a per-child
 * record key (`child-{id}`). Exported so callers
 * that walk an execution's storage directory (e.g.
 * `src/tools/executions/executionKvFiles.ts`) can recognize internal KV
 * entries without re-deriving this vocabulary themselves.
 */
export function isReservedKvKeyName(key: string): boolean {
  return RESERVED_KEY_NAMES.has(key) || key.startsWith(CHILD_KEY_PREFIX);
}

const CHANNEL = 'ExecutionKVStore';
type ExecutionMetaInput = z.input<typeof ExecutionMetaSchema>;

// ============================================================================
// Domain types — Zod schemas as source of truth
// ============================================================================

/** Display shape for a completed todo item. */
export interface TodoEntry {
  content?: string;
  status?: string;
}
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

/**
 * Logical identity of one child run turn (#9531, introduced 2026-08-03): a
 * stable turn token plus the delivery id its single parent delivery is
 * admitted under. Minted by the child-run loop per accepted turn — not by a
 * global registry — so the same logical delivery always carries the same id
 * and distinct turns never share one.
 */
const TurnRefSchema = z.object({
  token: z.string(),
  deliveryId: z.string(),
});
export type ChildTurnRef = z.infer<typeof TurnRefSchema>;

/**
 * Turn attribution for a child run's single latest-value report/result
 * slots: the turn currently running (or interrupted mid-flight before its
 * result was persisted) versus the latest turn whose result WAS persisted.
 * Absent entirely on executions that predate turn identity or never had
 * turns (e.g. background commands).
 */
const ChildTurnStateSchema = z.object({
  activeTurn: TurnRefSchema.optional(),
  lastCompletedTurn: TurnRefSchema.optional(),
});
export type ChildTurnState = z.infer<typeof ChildTurnStateSchema>;

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
  /**
   * Read metadata while preserving the distinction between an absent record
   * and a malformed present record. Durable repair paths use this accessor so
   * corruption stops recovery instead of being treated as missing state.
   */
  readMetaStrict(): Promise<ExecutionMeta | null>;
  /** The persisted run record: honest union across agent and non-agent runs. */
  readRunRecord(): Promise<RunRecord | null>;
  /** Agent-arm view of the run record; null for non-agent records. */
  readConfig(): Promise<AgentConfig | null>;
  readReport(): Promise<string | null>;
  readWorkspaceFiles(): Promise<string[]>;
  readChildren(): Promise<ChildRecord[]>;
  readResultMeta(): Promise<ResultMeta | null>;
  readTurnState(): Promise<ChildTurnState | null>;

  // -- Typed writers --------------------------------------------------------
  writeMeta(meta: ExecutionMetaInput): Promise<void>;
  writeRunRecord(record: RunRecord): Promise<void>;
  writeReport(report: string): Promise<void>;
  writeWorkspaceFiles(paths: readonly string[]): Promise<void>;
  writeChild(childId: ExecutionId, data: ChildRecordData): Promise<void>;
  writeResultMeta(data: ResultMeta): Promise<void>;
  writeTurnState(state: ChildTurnState): Promise<void>;
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
    // Compact JSON: flow records rewrite full shared state on every node
    // transition, so pretty-printing this machine-owned store is pure churn.
    super(resolveRunStoragePath(executionId), { compactJson: true });
  }

  override async write<T = unknown>(key: string, value: T): Promise<void> {
    await runWithExecutionLeaseWriteFence(this.executionId, () =>
      super.write(key, value),
    );
  }

  override async delete(key: string): Promise<void> {
    await runWithExecutionLeaseWriteFence(this.executionId, () =>
      super.delete(key),
    );
  }

  async clear(): Promise<void> {
    return runWithExecutionLeaseWriteFence(this.executionId, () =>
      this.deleteDir(),
    );
  }

  getExecutionId(): ExecutionId {
    return this.executionId;
  }

  // -- Typed readers --------------------------------------------------------

  /**
   * Read a key and validate it against a schema, returning the parsed value
   * or `null` when the key is absent. Permissive typed readers also return
   * `null` after warning about malformed data; durable repair selects the
   * throwing policy so corruption remains distinct from absence. This is the
   * single validation boundary shared by both policies.
   */
  private async readValidated<T>(
    key: string,
    schema: z.ZodType<T>,
    malformed: 'return-null' | 'throw' = 'return-null',
  ): Promise<T | null> {
    const raw = await this.read(key);
    if (raw === undefined) return null;
    const result = schema.safeParse(raw);
    if (result.success) return result.data;
    logger.warn(
      CHANNEL,
      `Failed to parse execution ${this.executionId} ${key}.json: ${toErrorMessage(
        result.error,
      )}`,
      { data: result.error },
    );
    if (malformed === 'throw') throw result.error;
    return null;
  }

  private async readValidatedMeta(
    malformed: 'return-null' | 'throw' = 'return-null',
  ): Promise<ExecutionMeta | null> {
    const raw = await this.read(KEYS.META);
    if (raw === undefined) return null;

    const core = ExecutionMetaCoreSchema.safeParse(raw);
    if (!core.success) {
      logger.warn(
        CHANNEL,
        `Failed to parse execution ${this.executionId} meta.json: ${toErrorMessage(
          core.error,
        )}`,
        { data: core.error },
      );
      if (malformed === 'throw') throw core.error;
      return null;
    }

    const workflow = WorkflowExecutionSnapshotSchema.optional().safeParse(
      (raw as { workflow?: unknown }).workflow,
    );
    if (!workflow.success) {
      logger.warn(
        CHANNEL,
        `Failed to parse execution ${this.executionId} meta.json workflow: ${toErrorMessage(
          workflow.error,
        )}`,
        { data: workflow.error },
      );
      // Ordinary reads keep core metadata so listing/finalization survive a
      // bad workflow projection. Strict recovery must fail closed so a present
      // but corrupt snapshot is never treated as "no prior state."
      if (malformed === 'throw') throw workflow.error;
      return core.data;
    }
    return workflow.data === undefined
      ? core.data
      : { ...core.data, workflow: workflow.data };
  }

  async readMeta(): Promise<ExecutionMeta | null> {
    return this.readValidatedMeta();
  }

  async readRunRecord(): Promise<RunRecord | null> {
    return this.readValidated(KEYS.CONFIG, RunRecordSchema);
  }

  async readMetaStrict(): Promise<ExecutionMeta | null> {
    return this.readValidatedMeta('throw');
  }

  /**
   * Agent-arm view of the run record: null when the record is a non-agent
   * run's honest minimal shape. Pre-consolidation non-agent rows persisted a
   * fabricated `AgentConfig` and still read through this arm.
   */
  async readConfig(): Promise<AgentConfig | null> {
    const record = await this.readRunRecord();
    return record && isAgentRunRecord(record) ? record : null;
  }

  async readReport(): Promise<string | null> {
    return (await this.read<string>(KEYS.REPORT)) ?? null;
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
        const data = await this.readValidated(key, ChildRecordDataSchema);
        return data ? { id, ...data } : null;
      }),
    );
    return entries.filter(filterNotNull);
  }

  async readResultMeta(): Promise<ResultMeta | null> {
    const [record, meta] = await Promise.all([
      this.readValidated(KEYS.RESULT_META, ResultMetaSchema),
      this.readMeta(),
    ]);
    return record ? applyExecutionOutcome(record, meta?.outcome) : null;
  }

  async readTurnState(): Promise<ChildTurnState | null> {
    return this.readValidated(KEYS.TURN_STATE, ChildTurnStateSchema);
  }

  // -- Typed writers --------------------------------------------------------

  async writeMeta(meta: ExecutionMetaInput): Promise<void> {
    await this.write(KEYS.META, ExecutionMetaSchema.parse(meta));
  }

  async writeRunRecord(record: RunRecord): Promise<void> {
    await this.write(KEYS.CONFIG, RunRecordSchema.parse(record));
  }

  async writeReport(report: string): Promise<void> {
    await this.write(KEYS.REPORT, report);
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

  async writeTurnState(state: ChildTurnState): Promise<void> {
    await this.write(KEYS.TURN_STATE, ChildTurnStateSchema.parse(state));
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
