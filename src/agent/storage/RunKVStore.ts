/**
 * Run-scoped key-value store infrastructure.
 *
 * The child protocol's turn state retains file-backed key-value access
 * until PR 4 moves it into the event table. Canonical run metadata is read
 * and written through private events; the run loop writes the run ledger.
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
  ResultMetaSchema,
  aggregateId,
  type ResultMeta,
  type RunEnd,
  type SessionEvent,
  type SessionEventDraft,
  type RunId,
  type WorkflowRunSnapshot,
} from '@shared/schemas';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

import { runWithRunLeaseWriteFence } from './runLease';

// ============================================================================
// Key constants (implementation detail — not exported)
// ============================================================================

const KEYS = { TURN_STATE: 'turn-state' } as const;

/** Generic persistence remains scoped to the child protocol's turn state. */
export function isReservedKvKeyName(key: string): boolean {
  return key === KEYS.TURN_STATE;
}

const log = createLog('RunKVStore');

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
 * Run-scoped key-value store.
 *
 * All keys are automatically namespaced to the run context.
 * Values are JSON-serialized transparently.
 *
 * Typed accessors provide domain-specific reads with schema validation;
 * malformed or missing entries resolve to null.
 */
export interface RunKVStore {
  // -- Generic KV -----------------------------------------------------------
  read<T = unknown>(key: string): Promise<T | undefined>;
  write<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  listKeys(prefix?: string): Promise<string[]>;
  clear(): Promise<void>;
  getRunId(): RunId;

  readTurnState(): Promise<ChildTurnState | null>;
  writeTurnState(state: ChildTurnState): Promise<void>;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * StorageFS-backed implementation of RunKVStore.
 * Extends KVStore for generic file operations and adds typed accessors.
 * Stores data in executions/{runId}/{key}.json
 */
class StorageFSKVStore extends KVStore implements RunKVStore {
  constructor(private readonly runId: RunId) {
    super(resolveRunStoragePath(runId));
  }

  override async write<T = unknown>(key: string, value: T): Promise<void> {
    await runWithRunLeaseWriteFence(this.runId, () => super.write(key, value));
  }

  override async delete(key: string): Promise<void> {
    await runWithRunLeaseWriteFence(this.runId, () => super.delete(key));
  }

  async clear(): Promise<void> {
    return runWithRunLeaseWriteFence(this.runId, () => this.deleteDir());
  }

  getRunId(): RunId {
    return this.runId;
  }

  // -- Typed readers --------------------------------------------------------

  /**
   * Permissive read: a missing or malformed turn-state entry resolves to
   * `null`, with malformed data leaving a warn trace. Canonical run
   * metadata uses the strict event accessor.
   */
  async readTurnState(): Promise<ChildTurnState | null> {
    const raw = await this.read(KEYS.TURN_STATE);
    if (raw === undefined) return null;
    const result = ChildTurnStateSchema.safeParse(raw);
    if (result.success) return result.data;
    log.warn(
      `Failed to parse run ${this.runId} ${KEYS.TURN_STATE}.json: ${toErrorMessage(
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

/**
 * The run's terminal fact for the lifecycle it is in now, or null while this
 * lifecycle has not ended. "Ended" is a fact about the current lifecycle, not
 * about the aggregate: every activation publishes a `run.activate` row (the
 * launch and each resume), so a `run.activate` after the previous `run.end`
 * means the run started again and the earlier terminal fact belongs to the
 * lifecycle before it. Reading the aggregate's last `run.end` instead would
 * leave a resumed run carrying the outcome of a lifecycle it has already
 * left. Shared with `finalizeRun`, the row's one writer, so writer and
 * readers scope it identically.
 */
export function runEndFromEvents(
  rows: readonly SessionEvent[],
  runId: RunId,
): Extract<SessionEvent, { type: 'run.end' }> | null {
  const id = aggregateId('run', runId);
  const lifecycle = rows.findLast(
    (row): row is Extract<SessionEvent, { type: 'run.end' | 'run.activate' }> =>
      row.aggregateId === id &&
      (row.type === 'run.end' || row.type === 'run.activate'),
  );
  return lifecycle?.type === 'run.end' ? lifecycle : null;
}

/** Native access to named run metadata, with no file-backed read arm. */
export function getRunRecords(session: SessionHandle, runId: RunId) {
  const id = aggregateId('run', runId);
  const read = <A>(
    select: (rows: readonly SessionEvent[]) => A,
  ): Effect.Effect<A, Error> =>
    session.readRunRecords(runId).pipe(
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
  /** The latest `run.record` row; the database reads a closed run as absent. */
  const recordOf = (rows: readonly SessionEvent[]): RunRecord | null => {
    const event = rows.findLast(
      (row) => row.aggregateId === id && row.type === 'run.record',
    );
    return event?.type === 'run.record'
      ? RunRecordSchema.parse(event.record)
      : null;
  };
  return {
    /** The run has a `run.start` the database still lists: absent, or
     *  closed by its tombstone, reads false. */
    exists: (): Effect.Effect<boolean, Error> =>
      read((rows) =>
        rows.some((row) => row.aggregateId === id && row.type === 'run.start'),
      ),
    readRunRecord: (): Effect.Effect<RunRecord | null, Error> => read(recordOf),
    readConfig: (): Effect.Effect<AgentConfig | null, Error> =>
      read((rows) => {
        const record = recordOf(rows);
        return record && isAgentRunRecord(record) ? record : null;
      }),
    readReport: (): Effect.Effect<string | null, Error> =>
      read((rows) => {
        const event = rows.findLast(
          (row) => row.aggregateId === id && row.type === 'run.report',
        );
        return event?.type === 'run.report' ? event.report : null;
      }),
    /** The committed snapshot of a workflow-script run, for reopening it. */
    readWorkflow: (): Effect.Effect<WorkflowRunSnapshot | null, Error> =>
      read((rows) => {
        const event = rows.findLast(
          (row) => row.aggregateId === id && row.type === 'run.workflow',
        );
        return event?.type === 'run.workflow' ? event.workflow : null;
      }),
    readWorkspaceFiles: (): Effect.Effect<string[], Error> =>
      read((rows) => {
        const event = rows.findLast(
          (row) => row.aggregateId === id && row.type === 'run.workspaceFiles',
        );
        return event?.type === 'run.workspaceFiles' ? event.paths : [];
      }),
    readResultMeta: (): Effect.Effect<ResultMeta | null, Error> =>
      read((rows) => {
        const event = rows.findLast(
          (row) => row.aggregateId === id && row.type === 'run.result',
        );
        return event?.type === 'run.result' ? event.result : null;
      }),
    /** The run's terminal fact: outcome, error, usage and the flow's output. */
    readRunEnd: (): Effect.Effect<RunEnd | null, Error> =>
      read((rows) => {
        const end = runEndFromEvents(rows, runId);
        if (!end) return null;
        const { outcome, error, usage, output } = end;
        return {
          outcome,
          ...(error !== undefined ? { error } : {}),
          ...(usage !== undefined ? { usage } : {}),
          output,
        };
      }),
    writeRunRecord: (record: RunRecord) =>
      Effect.suspend(() =>
        write({
          type: 'run.record',
          aggregateId: id,
          record: RunRecordSchema.parse(record),
        }),
      ),
    clearReport: () =>
      write({ type: 'run.report', aggregateId: id, report: null }),
    writeReport: (report: string) =>
      write({ type: 'run.report', aggregateId: id, report }),
    writeWorkspaceFiles: (paths: readonly string[]) =>
      write({
        type: 'run.workspaceFiles',
        aggregateId: id,
        paths: [...paths],
      }),
    writeResultMeta: (result: ResultMeta) =>
      Effect.suspend(() =>
        write({
          type: 'run.result',
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

export function getRunStore(runId: RunId): RunKVStore {
  const cached = storeCache.get(runId);
  if (cached) return cached;
  const created = new StorageFSKVStore(runId);
  storeCache.set(runId, created);
  return created;
}

/** Clear the in-memory store cache. Called during extension deactivation. */
export function clearStoreCache(): void {
  storeCache.clear();
}
