/**
 * Execution lifecycle operations.
 *
 * Business logic that orchestrates reads and writes across execution stores.
 * Separated from ExecutionKVStore to keep the store a clean storage interface
 * with no cross-store mutations or error-swallowing policies.
 */

import type { RunRecord } from '@agent/core/definition/RunRecord';
import { flowKey } from '@agent/node/persistedFlow';

import * as logger from '@logger/logUtils';
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
import { KeyedMutex } from '@utils/core';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { throwUnwrapAggregate } from './storageErrors';
import { getExecutionStore } from './ExecutionKVStore';
import {
  acquireFreshExecutionLease,
  captureOwnedExecutionLease,
  type OwnedExecutionLeaseScope,
  releaseOwnedExecutionLease,
} from './executionLease';

const CHANNEL = 'ExecutionLifecycle';

function pinExecutionWorkingDirectory(record: RunRecord): RunRecord {
  const workingDirectory =
    record.workingDirectory?.trim() || WorkspaceFS.getPath()?.trim();
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
  const runWithOwnership = captureOwnedExecutionLease(executionId);
  await runWithOwnership(async () => {
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
      throwUnwrapAggregate(
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
  });
}

/**
 * Register a detached child execution and capture its fresh lease as the
 * caller's ownership scope — the register → capture pair every detached
 * launch site shares, owned here so the launch failure path has one home.
 * Wrap the pre-handoff launch work in `runWithOwnedExecutionLeaseLaunchGuard`
 * (from `./executionLease`) inside the returned scope so a failed launch
 * releases the lease instead of stranding it until the stale horizon.
 */
export async function registerOwnedExecution(
  executionId: ExecutionId,
  record: RunRecord,
  agentName: string,
  options: RegisterExecutionOptions,
): Promise<OwnedExecutionLeaseScope> {
  await registerExecution(executionId, record, agentName, options);
  return captureOwnedExecutionLease(executionId);
}

/**
 * Drop the previous run's terminal facts as a persisted execution is admitted
 * for resumption. `meta.outcome` owns "how did this run end" and every reader
 * projects it onto the turn-owned result envelope (`applyExecutionOutcome`), so
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
): Promise<void> {
  const meta = await getExecutionStore(executionId).readMeta();
  if (meta?.outcome === undefined) return;
  await enqueueMetaUpdate(executionId, () => ({ outcome: undefined }));
}

export interface FinalizeExecutionInput {
  readonly executionId: ExecutionId;
  readonly outcome: RunOutcome;
  readonly flowRecord: 'preserve' | 'delete';
}

export type FinalizeExecutionResult =
  | {
      readonly status: 'durable';
      readonly outcomePersisted: true;
      readonly flowRecord: 'preserved' | 'deleted';
    }
  | {
      readonly status: 'failed';
      readonly error: unknown;
      readonly stage:
        'terminal-status' | 'terminal-status-and-flow-record-delete';
      readonly outcomePersisted: false;
    }
  | {
      readonly status: 'failed';
      readonly error: unknown;
      readonly stage: 'flow-record-delete';
      readonly outcomePersisted: true;
    };

/** Persist terminal metadata, then apply the requested flow-record policy. */
export async function finalizeExecution({
  executionId,
  outcome,
  flowRecord,
}: FinalizeExecutionInput): Promise<FinalizeExecutionResult> {
  try {
    // Persist the canonical terminal outcome — the one terminal write.
    await enqueueMetaUpdate(executionId, () => ({ outcome }));
  } catch (error) {
    // A terminal COMPLETED/FAILED result must never retain a resumable flow,
    // even when the caller requested preservation before the status write failed.
    const deleteToFailClosed =
      flowRecord === 'delete' ||
      outcome === RUN_OUTCOME.COMPLETED ||
      outcome === RUN_OUTCOME.FAILED;
    if (deleteToFailClosed) {
      try {
        await getExecutionStore(executionId).delete(flowKey(executionId));
      } catch (deleteError) {
        return {
          status: 'failed',
          error: new AggregateError(
            [error, deleteError],
            `Terminal metadata and flow deletion failed for ${executionId}`,
          ),
          stage: 'terminal-status-and-flow-record-delete',
          outcomePersisted: false,
        };
      }
    }
    return {
      status: 'failed',
      error,
      stage: 'terminal-status',
      outcomePersisted: false,
    };
  }

  if (flowRecord === 'preserve') {
    return {
      status: 'durable',
      outcomePersisted: true,
      flowRecord: 'preserved',
    };
  }

  try {
    await getExecutionStore(executionId).delete(flowKey(executionId));
    return {
      status: 'durable',
      outcomePersisted: true,
      flowRecord: 'deleted',
    };
  } catch (error) {
    return {
      status: 'failed',
      error,
      stage: 'flow-record-delete',
      outcomePersisted: true,
    };
  }
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
    logger.debug(
      CHANNEL,
      `Failed to persist session description for ${executionId}: ${toErrorMessage(err)}`,
    );
  }
}
