/**
 * Restart repair: classify every candidate stream once and record what the
 * classification proves. Nothing is adopted and nothing is guessed.
 *
 * - `held_elsewhere`: another process owns the execution. The stream is
 *   marked held and left untouched; its owner closes its transcript.
 * - `unclassified`: the run's lease, metadata, or flow record could not be
 *   read. The stream is marked unclassified with the cause and left
 *   untouched; Resume re-reads and re-acquires, so it is the retry.
 * - `resumable` / `finished`: the owner is gone. The persisted outcome, if
 *   any, becomes the in-memory phase; otherwise the interruption is recorded
 *   as CANCELLED with the flow record preserved. A resumable stream is then
 *   continued only through the explicit Resume affordance.
 *
 * Classification reads only and runs in parallel; settlement is sequential
 * and fenced: the phase transition, the transcript close, and the outcome
 * write all happen inside one inactive-lease scope, so an acquirer cannot
 * claim the run between the classification and the write.
 *
 * Invariant: a resume checkpoint (`executions/<id>/flow_<id>.json`) is deleted
 * only by the user or by a genuinely COMPLETED run. Repair never infers FAILED
 * (it only publishes a persisted FAILED outcome), never restores WAITING, and
 * never passes `flowRecord: 'delete'`.
 */
import pMap from 'p-map';

import { runWithInactiveExecutionLease } from '@agent/storage/executionLease';
import {
  finalizeExecution as defaultFinalizeExecution,
  type FinalizeExecutionInput,
  type FinalizeExecutionResult,
} from '@agent/storage/executionLifecycle';
import type { StreamStatusMachine } from '@agent/runtime/StreamStatusService';
import {
  RUN_OUTCOME,
  type ExecutionId,
  type RunOutcome,
  type StreamTabId,
} from '@shared/schemas';
import {
  isInFlightPhase,
  STREAM_TRANSITION_CAUSE,
} from '@shared/streams/streamStatus';
import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  classifyRun as defaultClassifyRun,
  type RunClassification,
} from './runClassification';

const DEFAULT_CLASSIFICATION_CONCURRENCY = 4;

interface RestartRepairLogger {
  debug(message: string): void;
  warn(message: string, context?: { data?: unknown }): void;
  error(message: string, context?: { data?: unknown }): void;
}

export interface RestartRepairOptions {
  streamStatus: StreamStatusMachine;
  /** Streams to classify; the caller excludes runs live in this process. */
  repairStreams: Iterable<StreamTabId>;
  executionIds: ReadonlyMap<StreamTabId, ExecutionId>;
  closeRunningGroups(
    streamIds: readonly StreamTabId[],
    status: RunOutcome,
    now: number,
  ): Promise<readonly StreamTabId[]>;
  classifyRun?: (executionId: ExecutionId) => Promise<RunClassification>;
  /** Parallelism of the read-only classification phase. */
  classificationConcurrency?: number;
  finalizeExecution?: (
    input: FinalizeExecutionInput,
  ) => Promise<FinalizeExecutionResult>;
  logger?: RestartRepairLogger;
  now?: number;
  /** Stop before beginning another repair mutation after session teardown. */
  signal?: AbortSignal;
  /**
   * Revalidate one candidate immediately before mutation. Return `false` to
   * skip a stale candidate: the caller compares the status generation it
   * captured before the async classification, so a stream reused after
   * discovery but before its turn in the sequential settle loop is dropped.
   */
  isRepairCandidateCurrent?: (
    streamId: StreamTabId,
    executionId: ExecutionId | undefined,
  ) => boolean;
}

interface ClassifiedStream {
  readonly streamId: StreamTabId;
  readonly executionId: ExecutionId | undefined;
  readonly classification: RunClassification;
}

/**
 * Persist the CANCELLED outcome for a stream whose owner died without
 * recording one. The flow record is preserved whatever its state: repair
 * records the interruption, it never deletes. Finalization problems are
 * logged rather than thrown: the in-memory repair has already committed.
 */
async function recordInterruption(
  streamId: StreamTabId,
  executionId: ExecutionId,
  finalizeExecution: (
    input: FinalizeExecutionInput,
  ) => Promise<FinalizeExecutionResult>,
  logger: RestartRepairLogger | undefined,
): Promise<void> {
  try {
    const finalization = await finalizeExecution({
      executionId,
      outcome: RUN_OUTCOME.CANCELLED,
      flowRecord: 'preserve',
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
  } catch (error) {
    logger?.warn('Restart-repair finalization rejected unexpectedly', {
      data: { streamId, executionId, error },
    });
  }
}

/**
 * Apply one restart-repair pass. {@link SessionHandle} owns discovery and the
 * transcript callback; the explicit inputs here keep the state transition and
 * persistence writes independently testable.
 */
export async function repairRestartedStreams(
  options: RestartRepairOptions,
): Promise<void> {
  const now = options.now ?? Date.now();
  const classifyRun = options.classifyRun ?? defaultClassifyRun;
  const finalizeExecution =
    options.finalizeExecution ?? defaultFinalizeExecution;
  const isCurrent = (streamId: StreamTabId, executionId?: ExecutionId) =>
    options.isRepairCandidateCurrent?.(streamId, executionId) ?? true;

  // Phase 1: classify in parallel. Reads only, so order is irrelevant. One
  // unreadable run becomes `unclassified`; it never rejects the pass.
  const classified = await pMap(
    options.repairStreams,
    async (streamId): Promise<ClassifiedStream> => {
      // `executionIds` is the caller-owned identity channel: SessionHandle
      // populates it from snapshot sidecars. No suffix decode happens here
      // (#9590 A2). A stream with no execution has nothing to classify: its
      // transcript is closed as interrupted and nothing is recorded.
      const executionId = options.executionIds.get(streamId);
      if (!executionId || options.signal?.aborted) {
        return { streamId, executionId, classification: { kind: 'finished' } };
      }
      try {
        return {
          streamId,
          executionId,
          classification: await classifyRun(executionId),
        };
      } catch (error) {
        const cause = toErrorMessage(error);
        options.logger?.warn(
          `Cannot classify execution ${executionId} for stream ${streamId}: ${cause}`,
          { data: error },
        );
        return {
          streamId,
          executionId,
          classification: { kind: 'unclassified', cause },
        };
      }
    },
    {
      concurrency:
        options.classificationConcurrency ?? DEFAULT_CLASSIFICATION_CONCURRENCY,
    },
  );

  // Phase 2: settle sequentially.
  for (const { streamId, executionId, classification } of classified) {
    if (options.signal?.aborted) break;
    if (!isCurrent(streamId, executionId)) {
      options.logger?.debug(
        `Skipped restart repair for stream ${streamId}: it was reused during classification`,
      );
      continue;
    }

    switch (classification.kind) {
      case 'owned_here':
        // Classification only sees streams with no live flow context here, so
        // a lease this process holds is a registry/lease disagreement. Say so
        // and leave the stream alone rather than labelling it foreign.
        options.logger?.error(
          `Stream ${streamId} has no live flow context but this process holds execution ${executionId}; left unclassified`,
          { data: { streamId, executionId } },
        );
        continue;
      case 'held_elsewhere':
        options.streamStatus.markHeld(streamId);
        options.logger?.debug(
          `Stream ${streamId} is held by another process; left untouched`,
        );
        continue;
      case 'unclassified':
        options.streamStatus.markUnclassified(streamId, classification.cause);
        options.logger?.warn(
          `Stream ${streamId} left unclassified after restart: ${classification.cause}`,
          { data: { streamId, executionId } },
        );
        continue;
      case 'resumable':
      case 'finished':
        break;
    }

    // Owner gone. The persisted outcome is the display fact; without one the
    // interruption is recorded as CANCELLED and the checkpoint, if any, stays
    // for an explicit Resume. Everything below runs under the inactive-lease
    // lock: the same lock an acquirer takes, so nobody can claim the run
    // between the transcript close and the outcome write.
    const outcome = classification.outcome ?? RUN_OUTCOME.CANCELLED;
    let settleStarted = false;
    const settle = async (): Promise<void> => {
      settleStarted = true;
      if (!isCurrent(streamId, executionId)) {
        options.logger?.debug(
          `Skipped restart repair for stream ${streamId}: it was reused before settlement`,
        );
        return;
      }
      if (
        !options.streamStatus.transitionToTerminal(
          streamId,
          outcome,
          STREAM_TRANSITION_CAUSE.RESTART_REPAIR,
        )
      ) {
        options.logger?.warn(
          `Failed to settle stream ${streamId} as ${outcome} after restart`,
        );
        return;
      }
      options.logger?.debug(
        `Stream ${streamId} settled as ${outcome} during restart repair (${classification.kind})`,
      );
      await options.closeRunningGroups([streamId], outcome, now);
      if (executionId && classification.outcome == null) {
        await recordInterruption(
          streamId,
          executionId,
          finalizeExecution,
          options.logger,
        );
      }
    };
    if (!executionId) {
      await settle();
      continue;
    }
    let maintenance: Awaited<ReturnType<typeof runWithInactiveExecutionLease>>;
    try {
      maintenance = await runWithInactiveExecutionLease(executionId, settle);
    } catch (error) {
      // A settlement that already mutated must surface; a lock that could
      // not even be taken proves nothing, so the stream stays unclassified.
      if (settleStarted) throw error;
      const cause = `lease lock unavailable (${toErrorMessage(error)})`;
      options.streamStatus.markUnclassified(streamId, cause);
      options.logger?.warn(
        `Stream ${streamId} left unclassified after restart: ${cause}`,
        { data: error },
      );
      continue;
    }
    if (maintenance.status === 'active') {
      // Claimed between classification and settlement: that is the current
      // fact. A claim by this process means the stream is live here and the
      // registry already owns its phase.
      if (isInFlightPhase(options.streamStatus.get(streamId))) continue;
      options.streamStatus.markHeld(streamId);
      options.logger?.warn(
        `Execution ${executionId} was claimed while restart repair settled stream ${streamId}; now held elsewhere`,
        { data: { streamId, owner: maintenance.owner } },
      );
    }
  }
}
