/**
 * Restart repair: classify every transcript-unfinished stream once and record
 * what the classification proves. Nothing is adopted and nothing is guessed.
 *
 * - `held_elsewhere`: another process owns the execution. The stream is
 *   marked held and left untouched; its owner closes its transcript.
 * - `resumable` / `finished`: the owner is gone. The persisted outcome, if
 *   any, becomes the in-memory phase; otherwise the interruption is recorded
 *   as CANCELLED with the flow record preserved. A resumable stream is then
 *   continued only through the explicit Resume affordance.
 *
 * Invariant: a resume checkpoint (`executions/<id>/flow_<id>.json`) is deleted
 * only by the user or by a genuinely COMPLETED run. Repair never writes FAILED,
 * never restores WAITING, and never passes `flowRecord: 'delete'`.
 */
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
import { STREAM_TRANSITION_CAUSE } from '@shared/streams/streamStatus';
import {
  classifyRun as defaultClassifyRun,
  type RunClassification,
} from './runClassification';

interface RestartRepairLogger {
  debug(message: string): void;
  warn(message: string, context?: { data?: unknown }): void;
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
   * discovery but before its turn in this sequential loop is dropped.
   */
  isRepairCandidateCurrent?: (
    streamId: StreamTabId,
    executionId: ExecutionId | undefined,
  ) => boolean;
}

/**
 * Persist the CANCELLED outcome for a stream whose owner died without
 * recording one. The flow record is preserved whatever its state: repair
 * records the interruption, it never deletes. The write runs in the
 * inactive-lease maintenance scope: the classifier proved the owner gone,
 * and the write happens under a claim of its own, which reclaims the dead
 * owner's record exactly as an acquirer would. Finalization problems are
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
    const maintenance = await runWithInactiveExecutionLease(executionId, () =>
      finalizeExecution({
        executionId,
        outcome: RUN_OUTCOME.CANCELLED,
        flowRecord: 'preserve',
      }),
    );
    if (maintenance.status === 'active') {
      logger?.warn(
        `Execution ${executionId} was claimed while restart repair recorded its interruption; outcome left unrecorded`,
        { data: { streamId, owner: maintenance.owner } },
      );
      return;
    }
    const finalization = maintenance.value;
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
  const isCurrent = (streamId: StreamTabId, executionId?: ExecutionId) =>
    options.isRepairCandidateCurrent?.(streamId, executionId) ?? true;

  for (const streamId of options.repairStreams) {
    if (options.signal?.aborted) break;
    // `executionIds` is the caller-owned identity channel: SessionHandle
    // populates it from snapshot sidecars. No suffix decode happens here
    // (#9590 A2). A stream with no execution has nothing to classify: its
    // transcript is closed as interrupted and nothing is recorded.
    const executionId = options.executionIds.get(streamId);
    if (!isCurrent(streamId, executionId)) {
      options.logger?.debug(
        `Skipped restart repair for stream ${streamId}: it was reused during discovery`,
      );
      continue;
    }
    let classification: RunClassification;
    if (executionId) {
      // Unreadable execution storage rejects the whole pass: a run that
      // cannot be classified is surfaced at the readiness boundary, never
      // settled on a guess.
      classification = await classifyRun(executionId);
      if (options.signal?.aborted) break;
      if (!isCurrent(streamId, executionId)) {
        options.logger?.debug(
          `Skipped restart repair for stream ${streamId}: it was reused during classification`,
        );
        continue;
      }
    } else {
      classification = { kind: 'finished' };
    }

    if (classification.kind === 'held_elsewhere') {
      options.streamStatus.markHeld(streamId, classification.provable);
      options.logger?.debug(
        `Stream ${streamId} is held by ${
          classification.provable
            ? 'another process'
            : 'a process that cannot be reached'
        }; left untouched`,
      );
      continue;
    }

    // Owner gone. The persisted outcome is the display fact; without one the
    // interruption is recorded as CANCELLED and the checkpoint, if any, stays
    // for an explicit Resume.
    const outcome = classification.outcome ?? RUN_OUTCOME.CANCELLED;
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
      continue;
    }
    options.logger?.debug(
      `Stream ${streamId} settled as ${outcome} during restart repair (${classification.kind})`,
    );
    await options.closeRunningGroups([streamId], outcome, now);
    if (executionId && classification.outcome == null) {
      await recordInterruption(
        streamId,
        executionId,
        options.finalizeExecution ?? defaultFinalizeExecution,
        options.logger,
      );
    }
  }
}
