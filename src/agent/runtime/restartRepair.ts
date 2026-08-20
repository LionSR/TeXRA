import {
  finalizeExecution as defaultFinalizeExecution,
  type FinalizeExecutionInput,
  type FinalizeExecutionResult,
} from '@agent/storage/executionLifecycle';
import {
  runWithInactiveExecutionLease as defaultRunWithInactiveExecutionLease,
  type InactiveExecutionLeaseOptions,
} from '@agent/storage/executionLease';
import {
  probeInstance,
  type InstanceLiveness,
  type InstanceOwnerRecord,
} from '@agent/storage/instancePresence';
import { getExecutionStore } from '@agent/storage/ExecutionKVStore';
import { deriveResumability } from '@agent/storage/resumability';
import type { StreamStatusMachine } from '@agent/runtime/StreamStatusService';
import {
  RUN_OUTCOME,
  STREAM_PHASE,
  type ExecutionId,
  type RunOutcome,
  type StreamPhase,
  type StreamTabId,
} from '@shared/schemas';
import { STREAM_TRANSITION_CAUSE } from '@shared/streams/streamStatus';

interface RestartRepairLogger {
  debug(message: string): void;
  warn(message: string, context?: { data?: unknown }): void;
}

export interface RestartRepairOptions {
  streamStatus: StreamStatusMachine;
  waitingStreams: ReadonlySet<StreamTabId>;
  executionIds: ReadonlyMap<StreamTabId, ExecutionId>;
  closeRunningGroups(
    streamIds: readonly StreamTabId[],
    status: RunOutcome,
    now: number,
  ): Promise<readonly StreamTabId[]>;
  repairStreams?: Iterable<StreamTabId>;
  /** Retry terminal metadata after an earlier repair already moved a stream to FAILED. */
  retryFailedStreams?: boolean;
  finalizeExecution?: (
    input: FinalizeExecutionInput,
  ) => Promise<FinalizeExecutionResult>;
  /** Serialize liveness validation and repair mutations with acquisition. */
  runWithInactiveExecutionLease?: <T>(
    executionId: ExecutionId,
    operation: () => Promise<T>,
    options?: InactiveExecutionLeaseOptions,
  ) => Promise<
    | { readonly status: 'active'; readonly owner: InstanceOwnerRecord }
    | { readonly status: 'performed'; readonly value: T }
  >;
  /** Override liveness reads in focused tests. */
  probeOwner?: (owner: InstanceOwnerRecord) => Promise<InstanceLiveness>;
  logger?: RestartRepairLogger;
  now?: number;
  /** Stop before beginning another repair mutation after session teardown. */
  signal?: AbortSignal;
  /**
   * Revalidate one candidate under its execution lease, immediately before
   * settlement/mutation. Return `false` to skip the stale candidate — the
   * caller compares the status generation it captured before the async
   * ownership/detection pass, so a stream reused after discovery but before
   * its turn in this sequential loop is dropped.
   */
  isRepairCandidateCurrent?: (
    streamId: StreamTabId,
    executionId: ExecutionId | undefined,
  ) => boolean;
}

/** One stream skipped because its execution's owner is provably alive. */
interface ActiveOwnerSkip {
  readonly streamId: StreamTabId;
  readonly executionId: ExecutionId;
  readonly owner: InstanceOwnerRecord;
}

interface RestartRepairResult {
  /**
   * Streams left untouched because a live owner holds their execution. The
   * caller watches each owner's instance exit and re-runs repair on that
   * kernel-pushed event; nothing here is ever revisited on a clock.
   */
  readonly activeOwners: ActiveOwnerSkip[];
}

const RESTART_REPAIR_PHASES: ReadonlySet<StreamPhase> = new Set([
  STREAM_PHASE.RUNNING,
  STREAM_PHASE.WAITING,
]);

function repairCandidates(
  streamStatus: StreamStatusMachine,
  repairStreams?: Iterable<StreamTabId>,
): StreamTabId[] {
  if (repairStreams) return [...repairStreams];
  return [...streamStatus.entries()]
    .filter(([, phase]) => phase === STREAM_PHASE.RUNNING)
    .map(([streamId]) => streamId);
}

function livenessCacheKey(owner: InstanceOwnerRecord): string {
  return `${owner.hostname}\0${owner.instanceId}\0${owner.socketPath}`;
}

type ExecutionSettlement =
  | { readonly kind: 'unsettled' }
  | { readonly kind: 'settled'; readonly outcome: RunOutcome };

/**
 * Revalidate terminal metadata while holding the execution lease.
 *
 * A cancelled execution remains unsettled when it still has a resumable flow;
 * completed and failed executions are always terminal.
 */
async function readExecutionSettlement(
  executionId: ExecutionId,
): Promise<ExecutionSettlement> {
  const meta = await getExecutionStore(executionId).readMetaStrict();
  if (!meta || meta.outcome == null) {
    return { kind: 'unsettled' };
  }
  if (meta.outcome !== RUN_OUTCOME.CANCELLED) {
    return {
      kind: 'settled',
      outcome: meta.outcome,
    };
  }
  const resumability = await deriveResumability(executionId);
  return resumability.resumable
    ? { kind: 'unsettled' }
    : { kind: 'settled', outcome: RUN_OUTCOME.CANCELLED };
}

function synchronizeSettledPhase(
  streamStatus: StreamStatusMachine,
  streamId: StreamTabId,
  outcome: RunOutcome,
): void {
  const current = streamStatus.get(streamId);
  if (current == null || !RESTART_REPAIR_PHASES.has(current)) return;
  // The machine owns the WAITING -> RUNNING(resume) -> terminal escalation;
  // only the in-flight-phase guard above is repair-specific.
  streamStatus.transitionToTerminal(
    streamId,
    outcome,
    STREAM_TRANSITION_CAUSE.LIFECYCLE,
  );
}

/** Repair one stream back to WAITING, logging the outcome. */
function repairToWaiting(
  streamStatus: StreamStatusMachine,
  streamId: StreamTabId,
  logger: RestartRepairLogger | undefined,
): void {
  if (
    streamStatus.transition(
      streamId,
      STREAM_PHASE.WAITING,
      STREAM_TRANSITION_CAUSE.RESTART_REPAIR,
    )
  ) {
    logger?.debug(`Stream ${streamId} restored to WAITING after restart`);
    return;
  }
  logger?.warn(`Failed to repair stream ${streamId} to WAITING after restart`);
}

/**
 * Persist the FAILED terminal outcome for a repaired stream's execution,
 * reporting whether that outcome reached disk. Finalization problems are
 * logged rather than thrown: the in-memory repair has already committed.
 */
async function writeFailedOutcome(
  streamId: StreamTabId,
  executionId: ExecutionId,
  finalizeExecution: (
    input: FinalizeExecutionInput,
  ) => Promise<FinalizeExecutionResult>,
  logger: RestartRepairLogger | undefined,
): Promise<boolean> {
  try {
    const finalization = await finalizeExecution({
      executionId,
      outcome: RUN_OUTCOME.FAILED,
      flowRecord: 'delete',
    });
    if (finalization.status === 'failed') {
      logger?.warn('Failed to finalize restart-repair execution', {
        data: {
          streamId,
          executionId,
          stage: finalization.stage,
          outcomePersisted: finalization.outcomePersisted,
          error: finalization.error,
        },
      });
    }
    return finalization.outcomePersisted;
  } catch (error) {
    logger?.warn('Restart-repair finalization rejected unexpectedly', {
      data: { streamId, executionId, error },
    });
    return false;
  }
}

/**
 * Apply one restart-repair pass.
 *
 * {@link SessionHandle} owns discovery, lease-aware retries, and the
 * transcript callback. The explicit inputs here keep the state transition and
 * persistence writes independently testable.
 */
export async function repairRestartedStreams(
  options: RestartRepairOptions,
): Promise<RestartRepairResult> {
  const result: RestartRepairResult = { activeOwners: [] };
  const now = options.now ?? Date.now();
  const probeOwner = options.probeOwner ?? probeInstance;
  const ownerLiveness = new Map<string, Promise<InstanceLiveness>>();
  const inactiveLeaseOptions: InactiveExecutionLeaseOptions = {
    probeOwner: (owner) => {
      const key = livenessCacheKey(owner);
      let liveness = ownerLiveness.get(key);
      if (!liveness) {
        liveness = probeOwner(owner);
        ownerLiveness.set(key, liveness);
      }
      return liveness;
    },
  };

  for (const streamId of repairCandidates(
    options.streamStatus,
    options.repairStreams,
  )) {
    if (options.signal?.aborted) break;
    // `executionIds` is the caller-owned identity channel: SessionHandle
    // populates it from snapshot sidecars. No suffix decode happens here
    // (#9590 A2).
    const executionId = options.executionIds.get(streamId);
    let repairStarted = false;
    try {
      const repair = async () => {
        repairStarted = true;
        if (
          options.isRepairCandidateCurrent &&
          !options.isRepairCandidateCurrent(streamId, executionId)
        ) {
          return { kind: 'skipped' as const };
        }
        if (executionId) {
          const settlement = await readExecutionSettlement(executionId);
          if (options.signal?.aborted) {
            return { kind: 'cancelled' as const };
          }
          if (settlement.kind === 'settled') {
            synchronizeSettledPhase(
              options.streamStatus,
              streamId,
              settlement.outcome,
            );
            await options.closeRunningGroups(
              [streamId],
              settlement.outcome,
              now,
            );
            return { kind: 'settled' as const };
          }
        }
        if (options.signal?.aborted) {
          return { kind: 'cancelled' as const };
        }
        await repairRestartedStream(options, streamId, executionId, now);
        return { kind: 'repaired' as const };
      };
      const repaired = executionId
        ? await (
            options.runWithInactiveExecutionLease ??
            defaultRunWithInactiveExecutionLease
          )(executionId, repair, inactiveLeaseOptions)
        : { status: 'performed' as const, value: await repair() };
      if (repaired.status === 'active') {
        if (executionId) {
          result.activeOwners.push({
            streamId,
            executionId,
            owner: repaired.owner,
          });
        }
        options.logger?.debug(
          `Skipped restart repair for active execution ${executionId}`,
        );
        continue;
      }
      if (repaired.value.kind === 'cancelled') break;
      if (repaired.value.kind === 'skipped') {
        options.logger?.debug(
          `Skipped restart repair for stream ${streamId}: it was reused during discovery`,
        );
        continue;
      }
      if (repaired.value.kind === 'settled') {
        options.logger?.debug(
          `Skipped restart repair for terminal execution ${executionId}`,
        );
        continue;
      }
    } catch (error) {
      if (repairStarted) throw error;
      options.logger?.warn(
        `Skipped restart repair for execution ${executionId ?? streamId} because its lease or repair state could not be validated`,
        { data: error },
      );
    }
  }
  return result;
}

async function closeStreamAsCancelled(
  options: RestartRepairOptions,
  streamId: StreamTabId,
  now: number,
): Promise<void> {
  await options.closeRunningGroups([streamId], RUN_OUTCOME.CANCELLED, now);
}

async function closeStreamAsFailed(
  options: RestartRepairOptions,
  streamId: StreamTabId,
  executionId: ExecutionId | undefined,
  now: number,
): Promise<void> {
  await options.closeRunningGroups([streamId], RUN_OUTCOME.FAILED, now);
  if (executionId) {
    await writeFailedOutcome(
      streamId,
      executionId,
      options.finalizeExecution ?? defaultFinalizeExecution,
      options.logger,
    );
  }
}

async function repairRestartedStream(
  options: RestartRepairOptions,
  streamId: StreamTabId,
  executionId: ExecutionId | undefined,
  now: number,
): Promise<void> {
  if (options.signal?.aborted) return;
  const currentStatus = options.streamStatus.get(streamId);
  const isWaitingStream = options.waitingStreams.has(streamId);

  if (currentStatus == null) {
    if (isWaitingStream) {
      repairToWaiting(options.streamStatus, streamId, options.logger);
      await closeStreamAsCancelled(options, streamId, now);
      return;
    }
    // No in-memory phase: close the group as failed but leave the execution
    // un-terminalized — nothing here observed it reach a terminal state.
    await options.closeRunningGroups([streamId], RUN_OUTCOME.FAILED, now);
    return;
  }

  if (
    options.retryFailedStreams === true &&
    currentStatus === STREAM_PHASE.FAILED &&
    !isWaitingStream
  ) {
    await closeStreamAsFailed(options, streamId, executionId, now);
    return;
  }

  if (!RESTART_REPAIR_PHASES.has(currentStatus)) {
    if (isWaitingStream) {
      await closeStreamAsCancelled(options, streamId, now);
    }
    return;
  }

  if (isWaitingStream) {
    repairToWaiting(options.streamStatus, streamId, options.logger);
    await closeStreamAsCancelled(options, streamId, now);
    return;
  }

  if (
    options.streamStatus.transitionToTerminal(
      streamId,
      STREAM_PHASE.FAILED,
      STREAM_TRANSITION_CAUSE.RESTART_REPAIR,
    )
  ) {
    options.logger?.debug(
      `Stream ${streamId} set to FAILED during restart repair`,
    );
    await closeStreamAsFailed(options, streamId, executionId, now);
    return;
  }

  options.logger?.warn(`Failed to repair stream ${streamId} after restart`);
}
