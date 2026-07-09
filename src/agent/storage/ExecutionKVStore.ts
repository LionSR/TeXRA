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
import {
  CompileFailureSummarySchema,
  OutputFileSummarySchema,
} from '@shared/schemas/output';
import { byString, filterNotNull, normalizeFilePath } from '@utils/core';
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
   * Read on resume (for observability and `isSubagent` detection) without
   * having to walk a potentially broken parent chain.
   */
  delegationDepth: z.int().nonnegative().optional(),
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

/** Line-diff reference for one output file, relative to the run directory. */
const ResultDiffSummarySchema = z.object({
  /** Absolute path of the output file the diff belongs to. */
  path: z.string(),
  /** Diff file path relative to the execution run directory. */
  diffRelPath: z.string(),
  /** True when the change ratio exceeded the large-change threshold. */
  largeChange: z.boolean(),
});

const WorkflowResultMetaPayloadSchema = z.object({
  outputs: z.array(OutputFileSummarySchema),
  compileFailures: z.array(CompileFailureSummarySchema),
  copiedOutput: z.string().optional(),
  copiedOutputs: z.array(z.string()).optional(),
});

const SubagentWorkflowResultMetaPayloadSchema = z.object({
  category: z.literal('workflow'),
  outputs: z.array(OutputFileSummarySchema),
  compileFailures: z.array(CompileFailureSummarySchema).optional(),
  /** Line-diff files written for workflow outputs. */
  diffs: z.array(ResultDiffSummarySchema).optional(),
  /**
   * Present when diff generation failed for a workflow result: carries the
   * error so a chaining consumer distinguishes "diffs failed, read the
   * output files directly" from a genuine no-diff/clean result.
   */
  diffsUnavailable: z.string().optional(),
});

const SubagentToolUseResultMetaPayloadSchema = z.object({
  category: z.literal('toolUse'),
  /** Final assistant text (tool-use agents). */
  lastResponse: z.string().optional(),
  /** Workspace-relative paths touched by a tool-use run. */
  touchedFiles: z.array(z.string()).optional(),
});

const SubagentResultMetaPayloadSchema = z.discriminatedUnion('category', [
  SubagentWorkflowResultMetaPayloadSchema,
  SubagentToolUseResultMetaPayloadSchema,
]);

const BackgroundBashResultMetaSchema = z.object({
  producer: z.literal('backgroundBash'),
  exitCode: z.int().optional(),
  wallTimeMs: z.number().nonnegative(),
  success: z.boolean(),
  timedOut: z.boolean().optional(),
  command: z.string(),
});

const CliWorkflowResultMetaSchema = z.object({
  producer: z.literal('cliWorkflow'),
  result: WorkflowResultMetaPayloadSchema,
});

const SubagentResultMetaSchema = z.object({
  producer: z.literal('subagent'),
  /** Agent that produced this result (subagent completions). */
  agentName: z.string(),
  outcome: RunOutcomeSchema,
  success: z.boolean(),
  wallTimeMs: z.number().nonnegative(),
  /** Total model cost (USD) including the run's own subagents. */
  totalCostUsd: z.number().nonnegative().optional(),
  result: SubagentResultMetaPayloadSchema.optional(),
});

const CanonicalResultMetaSchema = z.discriminatedUnion('producer', [
  BackgroundBashResultMetaSchema,
  CliWorkflowResultMetaSchema,
  SubagentResultMetaSchema,
]);

const LegacyBackgroundBashResultMetaSchema = z
  .object({
    producer: z.undefined().optional(),
    exitCode: z.int().optional(),
    command: z.string(),
    wallTimeMs: z.number().nonnegative(),
    success: z.boolean(),
    timedOut: z.boolean().optional(),
  })
  .transform((meta) => ({
    producer: 'backgroundBash' as const,
    command: meta.command,
    wallTimeMs: meta.wallTimeMs,
    success: meta.success,
    ...(meta.exitCode !== undefined && { exitCode: meta.exitCode }),
    ...(meta.timedOut !== undefined && { timedOut: meta.timedOut }),
  }));

const LegacyCliWorkflowResultMetaSchema = z
  .object({
    producer: z.undefined().optional(),
    copiedOutput: z.string().optional(),
    copiedOutputs: z.array(z.string()).optional(),
    outputs: z.array(OutputFileSummarySchema).optional(),
    compileFailures: z.array(CompileFailureSummarySchema).optional(),
  })
  .refine(
    (meta) =>
      meta.outputs !== undefined ||
      meta.compileFailures !== undefined ||
      meta.copiedOutput !== undefined ||
      meta.copiedOutputs !== undefined,
    { message: 'legacy CLI workflow result metadata has no workflow fields' },
  )
  .transform((meta) => ({
    producer: 'cliWorkflow' as const,
    result: {
      outputs: meta.outputs ?? [],
      compileFailures: meta.compileFailures ?? [],
      ...(meta.copiedOutput !== undefined && {
        copiedOutput: meta.copiedOutput,
      }),
      ...(meta.copiedOutputs !== undefined && {
        copiedOutputs: meta.copiedOutputs,
      }),
    },
  }));

const LegacySubagentResultMetaSchema = z
  .object({
    producer: z.undefined().optional(),
    agentName: z.string(),
    category: z.enum(['workflow', 'toolUse']).optional(),
    outcome: RunOutcomeSchema,
    success: z.boolean(),
    wallTimeMs: z.number().nonnegative(),
    lastResponse: z.string().optional(),
    touchedFiles: z.array(z.string()).optional(),
    totalCostUsd: z.number().nonnegative().optional(),
    outputs: z.array(OutputFileSummarySchema).optional(),
    compileFailures: z.array(CompileFailureSummarySchema).optional(),
    diffs: z.array(ResultDiffSummarySchema).optional(),
    diffsUnavailable: z.string().optional(),
  })
  .transform((meta) => {
    // Legacy records from before `category` existed carry workflow/toolUse
    // fields with no category tag at all — infer it from which fields are
    // present rather than requiring it, or the payload silently disappears.
    const category =
      meta.category ??
      (meta.outputs !== undefined ||
      meta.compileFailures !== undefined ||
      meta.diffs !== undefined ||
      meta.diffsUnavailable !== undefined
        ? 'workflow'
        : meta.lastResponse !== undefined || meta.touchedFiles !== undefined
          ? 'toolUse'
          : undefined);

    const result =
      category === 'workflow'
        ? {
            category: 'workflow' as const,
            outputs: meta.outputs ?? [],
            ...(meta.compileFailures !== undefined && {
              compileFailures: meta.compileFailures,
            }),
            ...(meta.diffs !== undefined && { diffs: meta.diffs }),
            ...(meta.diffsUnavailable !== undefined && {
              diffsUnavailable: meta.diffsUnavailable,
            }),
          }
        : category === 'toolUse'
          ? {
              category: 'toolUse' as const,
              ...(meta.lastResponse !== undefined && {
                lastResponse: meta.lastResponse,
              }),
              ...(meta.touchedFiles !== undefined && {
                touchedFiles: meta.touchedFiles,
              }),
            }
          : undefined;

    return {
      producer: 'subagent' as const,
      agentName: meta.agentName,
      outcome: meta.outcome,
      success: meta.success,
      wallTimeMs: meta.wallTimeMs,
      ...(meta.totalCostUsd !== undefined && {
        totalCostUsd: meta.totalCostUsd,
      }),
      ...(result !== undefined && { result }),
    };
  });

const LegacyFlatResultMetaSchema = z.union([
  LegacyBackgroundBashResultMetaSchema,
  LegacySubagentResultMetaSchema,
  LegacyCliWorkflowResultMetaSchema,
]);

/**
 * Structured result of a finished execution — the machine-readable
 * counterpart of the prose report. This is the chaining contract: a later
 * stage (orchestrator or workflow script) reads outputs/diffs/outcome as
 * data instead of parsing the XML delivery.
 *
 * Canonical records are keyed by producer; legacy flat records are accepted
 * and normalized on read so existing execution metadata remains readable.
 */
export const ResultMetaSchema = z.union([
  CanonicalResultMetaSchema,
  LegacyFlatResultMetaSchema,
]);
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
    await this.write(KEYS.RESULT_META, CanonicalResultMetaSchema.parse(data));
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
