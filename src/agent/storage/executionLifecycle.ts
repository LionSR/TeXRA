/**
 * Execution lifecycle operations.
 *
 * Business logic that orchestrates reads and writes across execution stores.
 * Separated from ExecutionKVStore to keep the store a clean storage interface
 * with no cross-store mutations or error-swallowing policies.
 */

import type { RunRecord } from '@agent/core/definition/RunRecord';
import { flowKey } from '@agent/node/persistedFlow';

import { createLog } from '@logger/logUtils';
import {
  RUN_OUTCOME,
  USER_FOLLOW_UP_SUPPORT,
  type ExecutionId,
  type ExecutionMeta,
  type RegisteredExecutionMeta,
  type RunIdentity,
  type RunOutcome,
  type StreamTabId,
  type UserFollowUpSupport,
  type WorkflowExecutionSnapshot,
} from '@shared/schemas';
import { KeyedMutex, throwAggregated } from '@utils/core';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { getExecutionStore } from './ExecutionKVStore';
import {
  acquireFreshExecutionLease,
  releaseOwnedExecutionLease,
} from './executionLease';

const log = createLog('ExecutionLifecycle');

function pinExecutionWorkingDirectory(record: RunRecord): RunRecord {
  // First non-blank candidate wins, stored verbatim (untrimmed) — trimming
  // here previously mangled resumed workflow paths (2e3197f92f).
  const workingDirectory = [
    record.workingDirectory,
    WorkspaceFS.getPath(),
  ].find((dir) => dir?.trim());
  return workingDirectory ? { ...record, workingDirectory } : record;
}

/** Return whether readable persisted metadata directly links to a parent. */
export async function hasPersistedParent(
  executionId: ExecutionId,
): Promise<boolean> {
  const meta = await getExecutionStore(executionId).readMeta();
  return meta?.parentExecutionId !== undefined;
}

/** Read persisted follow-up capability, failing closed for absent metadata. */
export async function getPersistedUserFollowUpSupport(
  executionId: ExecutionId,
): Promise<UserFollowUpSupport> {
  const meta = await getExecutionStore(executionId).readMeta();
  return meta?.userFollowUpSupport ?? USER_FOLLOW_UP_SUPPORT.UNSUPPORTED;
}

// ---------------------------------------------------------------------------
// Per-execution write serialization — read-modify-write cycles on meta run one
// at a time per execution so that concurrent terminal-outcome /
// session-description writes never race and silently drop each other's
// fields. Different executions proceed independently.
// ---------------------------------------------------------------------------

const metaWriteLocks = new KeyedMutex<ExecutionId>();

/** Run a read-modify-write cycle on an execution's metadata under its lock. */
function enqueueMetaUpdate(
  executionId: ExecutionId,
  updater: (existing: ExecutionMeta) => Partial<ExecutionMeta>,
): Promise<void> {
  return metaWriteLocks.runExclusive(executionId, async () => {
    const store = getExecutionStore(executionId);
    const existing = await store.readMeta();
    if (!existing) {
      throw new Error(`Execution metadata not found for ${executionId}`);
    }
    await store.writeMeta({ ...existing, ...updater(existing) });
  });
}

/** Persist the workflow runner's canonical execution snapshot on its run. */
export function writeWorkflowExecutionSnapshot(
  executionId: ExecutionId,
  workflow: WorkflowExecutionSnapshot,
): Promise<void> {
  return enqueueMetaUpdate(executionId, () => ({ workflow }));
}

interface RegisterExecutionOptions {
  readonly streamId: StreamTabId;
  /** The run's identity, declared by the launch site — the durable authority. */
  readonly identity: RunIdentity;
  /** Runtime behavior declared by the launch source, not UI visibility. */
  readonly userFollowUpSupport?: UserFollowUpSupport;
  readonly parentExecutionId?: ExecutionId;
  /**
   * Display description persisted on `ExecutionMeta.description` — the one
   * description authority (#9590 A4). Child-stream launchers pass the
   * delegated task label here so it is durable at birth; the later
   * `updateStreamDescription` session event is display-only and no longer
   * writes a sidecar copy (#9590 Stage 6).
   */
  readonly description?: string;
}

/**
 * Register a new execution: persist config, metadata, and parent linkage.
 * Awaits all writes before returning.
 */
export async function registerExecution(
  executionId: ExecutionId,
  record: RunRecord,
  agentName: string,
  options: RegisterExecutionOptions,
): Promise<void> {
  const {
    streamId,
    identity,
    userFollowUpSupport,
    parentExecutionId,
    description,
  } = options;
  await acquireFreshExecutionLease(executionId);
  try {
    const timestamp = new Date().toISOString();
    const store = getExecutionStore(executionId);
    const meta: RegisteredExecutionMeta = {
      schemaVersion: 1,
      timestamp,
      streamId,
      identity,
      userFollowUpSupport:
        userFollowUpSupport ?? USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
      parentExecutionId,
      ...(description ? { description } : {}),
    };
    const persistedRecord = pinExecutionWorkingDirectory(record);

    const writes: Promise<void>[] = [
      store.writeRunRecord(persistedRecord),
      store.writeMeta(meta),
    ];
    if (parentExecutionId) {
      writes.push(
        getExecutionStore(parentExecutionId).writeChild(executionId, {
          agent: agentName,
          timestamp,
        }),
      );
    }

    const results = await Promise.allSettled(writes);
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    throwAggregated(
      errors,
      `Multiple execution registration writes failed for ${executionId}`,
    );
  } catch (error) {
    try {
      await releaseOwnedExecutionLease(executionId);
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        `Execution registration and lease rollback failed for ${executionId}`,
      );
    }
    throw error;
  }
}

/**
 * Drop the previous run's terminal facts as a persisted execution is admitted
 * for resumption. `meta.outcome` owns "how did this run end" and every reader
 * projects it onto the turn-owned result envelope (`readResultMeta`), so
 * an execution that resumes while still carrying its interrupted predecessor's
 * outcome relabels every turn the resumed run writes until its next terminal
 * finalize.
 *
 * Metadata that is absent or unreadable is left alone: `readResultMeta` reads
 * the same metadata, so there is no outcome to project either way, and the
 * store already warns about metadata it could not parse.
 */
export async function clearTerminalExecutionState(
  executionId: ExecutionId,
): Promise<{
  readonly previousOutcome: RunOutcome | undefined;
  readonly streamId: StreamTabId | undefined;
}> {
  const meta = await getExecutionStore(executionId).readMeta();
  if (meta?.outcome !== undefined) {
    await enqueueMetaUpdate(executionId, () => ({ outcome: undefined }));
  }
  return {
    previousOutcome: meta?.outcome,
    streamId: meta?.streamId,
  };
}

export interface FinalizeExecutionInput {
  readonly executionId: ExecutionId;
  readonly outcome: RunOutcome;
  readonly flowRecord: 'preserve' | 'delete';
  /**
   * Keep an outcome already on disk instead of replacing it. For a backstop
   * finalizer that does not own the run's result — the host-exit drain, which
   * can race the run's own driver across the same per-execution meta lock —
   * the driver's outcome is the authoritative one. Read and write happen in
   * the same locked cycle, so "already settled" cannot go stale between them.
   */
  readonly keepExistingOutcome?: boolean;
  /**
   * Where a persistence failure is reported, wrapped in one worded Error.
   * `finalizeRun` never throws; a caller with its own logging reads the
   * result instead.
   */
  readonly report?: (error: Error) => void;
}

export type FinalizeExecutionResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly error: unknown;
      readonly outcomePersisted: boolean;
    };

/**
 * The one terminal-persistence tail: persist the run's terminal outcome,
 * then apply the requested flow-record policy. Never throws — every
 * persistence failure comes back as an `ok: false` result (and through
 * `report`, when given).
 */
export async function finalizeRun(
  input: FinalizeExecutionInput,
): Promise<FinalizeExecutionResult> {
  const { executionId, outcome, flowRecord, keepExistingOutcome } = input;
  const failed = (
    error: unknown,
    outcomePersisted: boolean,
  ): FinalizeExecutionResult => {
    input.report?.(
      new Error(
        `Failed to persist ${outcome} terminal state for execution ${executionId}: ${toErrorMessage(error)}`,
        { cause: error },
      ),
    );
    return { ok: false, error, outcomePersisted };
  };
  try {
    // Persist the canonical terminal outcome — the one terminal write.
    await enqueueMetaUpdate(executionId, (existing) =>
      keepExistingOutcome === true && existing.outcome != null
        ? {}
        : { outcome },
    );
  } catch (error) {
    // The caller's disposition stands even when the outcome write failed: a
    // checkpoint is deleted only on request, never to fail closed.
    if (flowRecord === 'delete') {
      try {
        await getExecutionStore(executionId).delete(flowKey(executionId));
      } catch (deleteError) {
        return failed(
          new AggregateError(
            [error, deleteError],
            `Terminal metadata and flow deletion failed for ${executionId}`,
          ),
          false,
        );
      }
    }
    return failed(error, false);
  }

  if (flowRecord === 'delete') {
    try {
      await getExecutionStore(executionId).delete(flowKey(executionId));
    } catch (error) {
      return failed(error, true);
    }
  }
  return { ok: true };
}

/** Persist an AI-generated session description on an existing execution's metadata. */
export async function writeSessionDescription(
  executionId: ExecutionId,
  description: string,
): Promise<void> {
  // Best-effort, serialized with other meta updates for the same execution to
  // prevent read-modify-write races (e.g. against terminal status). Never
  // throws: the description is presentation metadata, not lifecycle state.
  try {
    await enqueueMetaUpdate(executionId, () => ({ description }));
  } catch (err) {
    // Swallow and log — don't let storage I/O errors disrupt execution lifecycle.
    log.debug(
      `Failed to persist session description for ${executionId}: ${toErrorMessage(err)}`,
    );
  }
}
