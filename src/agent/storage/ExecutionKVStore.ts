/**
 * Execution-scoped key-value store infrastructure.
 *
 * Checkpoints and delegation state retain file-backed key-value access.
 * Canonical execution metadata is read and written through private events.
 */

import { Cause, Effect } from 'effect';

import { LRUCache } from 'lru-cache';
import { z } from 'zod';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import {
  isAgentRunRecord,
  RunRecordSchema,
  type RunRecord,
} from '@agent/core/definition/RunRecord';
import { KVStore } from '@common/storage/KVStore';
import { createLog } from '@logger/logUtils';
import { resolveRunStoragePath } from '@platform/defaults/workspaceStorage';
import {
  ExecutionMetaSchema,
  RUN_OUTCOME,
  aggregateId,
  EXECUTION_META_SCHEMA_VERSION,
  type SessionEvent,
  type SessionEventDraft,
  type RunId,
  type ExecutionMeta,
} from '@shared/schemas';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

import { ResultMetaSchema, type ResultMeta } from './resultMeta';
import { runWithExecutionLeaseWriteFence } from './executionLease';

// ============================================================================
// Key constants (implementation detail — not exported)
// ============================================================================

const KEYS = { TURN_STATE: 'turn-state' } as const;

/** Generic persistence remains scoped to checkpoints and delegation state. */
export function isReservedKvKeyName(key: string): boolean {
  return key === KEYS.TURN_STATE;
}

const log = createLog('ExecutionKVStore');

// ============================================================================
// Domain types — Zod schemas as source of truth
// ============================================================================

/** A child launch projected from its canonical creation fact. */
export interface ChildRecord {
  readonly id: RunId;
  readonly agent: string;
  readonly timestamp: string;
}

/**
 * Logical identity of one child run turn (#9531, introduced 2026-08-03): a
 * stable turn token. Minted by the child-run loop per accepted turn — not by a
 * global registry — so the same logical delivery always carries the same id
 * and distinct turns never share one. The delivery id its single parent
 * delivery is admitted under is derived from this token at the enqueue site.
 */
const TurnRefSchema = z.object({
  token: z.string(),
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
  getExecutionId(): RunId;

  readTurnState(): Promise<ChildTurnState | null>;
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
  constructor(private readonly executionId: RunId) {
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

  getExecutionId(): RunId {
    return this.executionId;
  }

  // -- Typed readers --------------------------------------------------------

  /**
   * Permissive read: a missing or malformed turn-state entry resolves to
   * `null`, with malformed data leaving a warn trace. Canonical execution
   * metadata uses the strict event accessor.
   */
  async readTurnState(): Promise<ChildTurnState | null> {
    const raw = await this.read(KEYS.TURN_STATE);
    if (raw === undefined) return null;
    const result = ChildTurnStateSchema.safeParse(raw);
    if (result.success) return result.data;
    log.warn(
      `Failed to parse execution ${this.executionId} ${KEYS.TURN_STATE}.json: ${toErrorMessage(
        result.error,
      )}`,
      { data: result.error },
    );
    return null;
  }

  async writeTurnState(state: ChildTurnState): Promise<void> {
    await this.write(KEYS.TURN_STATE, ChildTurnStateSchema.parse(state));
  }
}

/** Fold the named metadata records for one run from one database prefix. */
export function executionMetaFromEvents(
  rows: readonly SessionEvent[],
  executionId: RunId,
): ExecutionMeta | null {
  const id = aggregateId('run', executionId);
  const start = rows.find(
    (row): row is Extract<SessionEvent, { type: 'run.start' }> =>
      row.type === 'run.start' && row.aggregateId === id,
  );
  if (!start || rows.some((row) => row.aggregateId === id && row.type === 'stream.removed'))
    return null;
  const status = rows.findLast(
    (row) => row.aggregateId === id && row.type === 'status',
  );
  const description = rows.findLast(
    (row) => row.aggregateId === id && row.type === 'execution.description',
  );
  const workflow = rows.findLast(
    (row) => row.aggregateId === id && row.type === 'execution.workflow',
  );
  // The parent edge: `run.start.parent`, severed by a later `run.detach`.
  const detached = rows.some(
    (row) => row.aggregateId === id && row.type === 'run.detach',
  );
  return ExecutionMetaSchema.parse({
    schemaVersion: EXECUTION_META_SCHEMA_VERSION,
    timestamp: new Date(start.at).toISOString(),
    identity: start.identity ?? undefined,
    userFollowUpSupport: start.userFollowUpSupport,
    parentExecutionId:
      detached || start.parent === null ? undefined : start.parent.id,
    outcome:
      status?.type === 'status' &&
      (status.phase === RUN_OUTCOME.COMPLETED ||
        status.phase === RUN_OUTCOME.CANCELLED ||
        status.phase === RUN_OUTCOME.FAILED)
        ? status.phase
        : undefined,
    description:
      description?.type === 'execution.description'
        ? description.description
        : undefined,
    workflow:
      workflow?.type === 'execution.workflow' ? workflow.workflow : undefined,
  });
}

/** Read the current configuration from the same committed prefix as metadata. */
export function executionRunRecordFromEvents(
  rows: readonly SessionEvent[],
  executionId: RunId,
): RunRecord | null {
  if (!executionMetaFromEvents(rows, executionId)) return null;
  const id = aggregateId('run', executionId);
  const event = rows.findLast(
    (row) => row.aggregateId === id && row.type === 'execution.config',
  );
  return event?.type === 'execution.config'
    ? RunRecordSchema.parse(event.record)
    : null;
}

/** Native access to named run metadata, with no file-backed read arm. */
export function getExecutionRecords(
  session: SessionHandle,
  executionId: RunId,
) {
  const id = aggregateId('run', executionId);
  const read = <A>(
    select: (rows: readonly SessionEvent[]) => A,
  ): Effect.Effect<A, Error> =>
    session.readExecutionRecords(executionId).pipe(
      Effect.map(select),
      Effect.catchCause((cause) => {
        const error = Cause.squash(cause);
        return Effect.fail(
          error instanceof z.ZodError ? error : ensureError(error),
        );
      }),
    );
  const write = (draft: SessionEventDraft): Effect.Effect<void, Error> =>
    session.commit([draft]).pipe(
      Effect.asVoid,
      Effect.catchCause((cause) => {
        const error = Cause.squash(cause);
        return Effect.fail(
          error instanceof z.ZodError ? error : ensureError(error),
        );
      }),
    );
  const metaOf = (rows: readonly SessionEvent[]) =>
    executionMetaFromEvents(rows, executionId);
  const recordOf = (rows: readonly SessionEvent[]) =>
    executionRunRecordFromEvents(rows, executionId);
  return {
    readMeta: (): Effect.Effect<ExecutionMeta | null, Error> => read(metaOf),
    readRunRecord: (): Effect.Effect<RunRecord | null, Error> => read(recordOf),
    readConfig: (): Effect.Effect<AgentConfig | null, Error> =>
      read((rows) => {
        const record = recordOf(rows);
        return record && isAgentRunRecord(record) ? record : null;
      }),
    readReport: (): Effect.Effect<string | null, Error> =>
      read((rows) => {
        const event = rows.findLast(
          (row) => row.aggregateId === id && row.type === 'execution.report',
        );
        return event?.type === 'execution.report' ? event.report : null;
      }),
    readWorkspaceFiles: (): Effect.Effect<string[], Error> =>
      read((rows) => {
        const event = rows.findLast(
          (row) =>
            row.aggregateId === id && row.type === 'execution.workspaceFiles',
        );
        return event?.type === 'execution.workspaceFiles' ? event.paths : [];
      }),
    readResultMeta: (): Effect.Effect<ResultMeta | null, Error> =>
      read((rows) => {
        const event = rows.findLast(
          (row) => row.aggregateId === id && row.type === 'execution.result',
        );
        if (event?.type !== 'execution.result') return null;
        const record = event.result;
        const outcome = metaOf(rows)?.outcome;
        if (
          record.producer === 'backgroundBash' ||
          outcome === undefined ||
          outcome === RUN_OUTCOME.COMPLETED ||
          record.result.outcome === outcome
        )
          return record;
        return ResultMetaSchema.parse({
          ...record,
          result: { ...record.result, outcome },
        });
      }),
    writeRunRecord: (record: RunRecord) =>
      Effect.suspend(() =>
        write({
          type: 'execution.config',
          aggregateId: id,
          record: RunRecordSchema.parse(record),
        }),
      ),
    clearReport: () =>
      write({ type: 'execution.report', aggregateId: id, report: null }),
    writeReport: (report: string) =>
      write({ type: 'execution.report', aggregateId: id, report }),
    writeWorkspaceFiles: (paths: readonly string[]) =>
      write({
        type: 'execution.workspaceFiles',
        aggregateId: id,
        paths: [...paths],
      }),
    writeResultMeta: (result: ResultMeta) =>
      Effect.suspend(() =>
        write({
          type: 'execution.result',
          aggregateId: id,
          result: ResultMetaSchema.parse(result),
        }),
      ),
  };
}

// ============================================================================
// Factory
// ============================================================================

// LRU-capped store cache. StorageFSKVStore is stateless (file-backed),
// so eviction is lossless — re-creation just makes a new thin wrapper. The
// cache exists for instance identity (callers spy on the returned store),
// not to avoid work.
const storeCache = new LRUCache<RunId, StorageFSKVStore>({ max: 50 });

export function getExecutionStore(executionId: RunId): ExecutionKVStore {
  const cached = storeCache.get(executionId);
  if (cached) return cached;
  const created = new StorageFSKVStore(executionId);
  storeCache.set(executionId, created);
  return created;
}

/** Clear the in-memory store cache. Called during extension deactivation. */
export function clearStoreCache(): void {
  storeCache.clear();
}
