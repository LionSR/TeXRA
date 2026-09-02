/**
 * Termination cascade for suspended runs.
 *
 * Tears down an `AgentExecutionHandle` parked at WAITING with no live
 * interrupt context: publishes the terminal `result`, settles
 * `handle.result`, persists the terminal status, and releases the execution
 * lease, all on behalf of `ExecutionRegistry.terminate`.
 */

import { createChannelTrace, type ResultEvent } from '@agent/trace';
import { ExecutionLeaseLostError } from '@agent/storage/executionLease';
import {
  finalizeRun,
  retainFlowRecordUnlessCompleted,
} from '@agent/storage/executionLifecycle';
import {
  RUN_OUTCOME,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import type { AgentExecutionHandle } from './ExecutionHandle';
import type { ExecutionLanes } from './executionLanes';

const logger = createChannelTrace('executionRegistry');

/**
 * The registry-owned collaborators the waiting-termination cascade needs,
 * injected so the registry stays the single owner of handles, stream status,
 * and the session's lease-release boundary.
 */
export interface WaitingTerminationContext {
  readonly publishResult: (event: ResultEvent, streamId: StreamTabId) => void;
  readonly releaseRootExecutionLease: (
    executionId: ExecutionId,
  ) => Promise<void>;
  readonly lanes: ExecutionLanes;
  readonly getHandle: (executionId: string) => AgentExecutionHandle | undefined;
  readonly untrackIfCurrent: (handle: AgentExecutionHandle) => boolean;
  readonly untrackHandle: (handle: AgentExecutionHandle) => void;
  readonly cancelStreamStatus: (streamId: StreamTabId) => void;
}

export class WaitingTermination {
  constructor(private readonly context: WaitingTerminationContext) {}

  /**
   * Tear down an `AgentExecutionHandle` parked at WAITING with no live
   * interrupt context, returning whether this stop claimed the run.
   *
   * The handle's own suspension is the single authority on both questions this
   * path used to cross-check: `runFlowWithLifecycle`'s WAITING branch is what
   * parks a handle, and `beginSuspendedTermination` claims the run's terminal
   * outcome and starts the teardown in one synchronous step. So a handle that
   * never parked (one merely between its own interrupt-handler detach and
   * untrack during normal teardown) and a run whose terminal outcome
   * `finalizeRunTerminal` already claimed both leave this a no-op, with no
   * `streamStatus` re-read: a stop can neither abandon a live run nor publish
   * a second outcome. That also covers the window
   * `resumeQueuedToolUseFromResumeData` opens by flipping the stream to
   * RUNNING/RESUMING before the resumed run installs its own context — the
   * suspended handle it replaces is still parked, so a stop landing there
   * still tears the stalled resume down.
   *
   * This path bypasses `runFlowWithLifecycle`'s own terminal handling (the
   * flow never resumes to produce one), so it publishes the terminal
   * `result`, settles `handle.result`, and persists the terminal status
   * itself — otherwise trace/session subscribers would miss the stop, a
   * consumer awaiting `handle.result` (F-2) would hang forever, and the
   * execution's history would keep a non-terminal status. Unlike
   * `finalizeRunTerminal`, no usage totals ride the event: the flow is
   * suspended, so there is no live usage monitor to read.
   *
   * `handle.trace` belongs to the turn that suspended this handle at WAITING,
   * and `runFlowWithLifecycle`'s own `finally` already disposed it (channel +
   * transcript + session bridge) the moment that turn returned — emitting on
   * it is a harmless best effort, not the real fix. `publishResult` (wired
   * from `SessionHandle.publishRunEvent`) reaches this session's
   * `onResult`/event-bus subscribers directly instead, so a user-initiated
   * stop of a suspended native subagent still surfaces a terminal event even
   * though the turn's own trace is already gone.
   */
  terminateWaitingHandle(handle: AgentExecutionHandle): boolean {
    const teardown = handle.beginSuspendedTermination();
    if (!teardown) return false;
    const cancelledResult: ResultEvent = {
      type: 'result',
      outcome: RUN_OUTCOME.CANCELLED,
      executionId: handle.executionId,
      streamId: handle.childStreamId,
      agentName: handle.agentName,
      category: handle.category,
      isSubagent: handle.isChildExecution,
    };
    const termination = this.finishWaitingTermination(
      handle,
      teardown,
      cancelledResult,
    ).catch(async (error: unknown) => {
      // Durable finalization never ran, so recovery only settles what this
      // generation privately owns. Each step is guarded on its own: a failure
      // in one must not cost the others. A former generation owns only its
      // private result — it must not mark, release, untrack, or cancel a
      // locally reacquired successor, which is what `untrackIfCurrent` gates.
      const recoveryFailures = [error];
      let untracked = false;
      try {
        handle.settleResult(cancelledResult);
      } catch (recoveryError) {
        recoveryFailures.push(recoveryError);
      }
      try {
        untracked = this.context.untrackIfCurrent(handle);
        if (untracked) {
          this.context.cancelStreamStatus(handle.childStreamId);
        }
      } catch (recoveryError) {
        recoveryFailures.push(recoveryError);
      }
      // A lost lease is already gone: releasing it would reach whatever holds
      // the record now. Every other failure still owes the release.
      if (
        untracked &&
        !handle.isChildExecution &&
        !(error instanceof ExecutionLeaseLostError)
      ) {
        try {
          await this.context.releaseRootExecutionLease(handle.executionId);
        } catch (recoveryError) {
          recoveryFailures.push(recoveryError);
        }
      }
      logger.warn(
        'Waiting-execution termination failed; settled the run without durable finalization',
        { data: { executionId: handle.executionId, recoveryFailures } },
      );
    });
    this.context.lanes.holdLive(handle.executionId, termination);
    return true;
  }

  private async finishWaitingTermination(
    handle: AgentExecutionHandle,
    teardown: Promise<void>,
    cancelledResult: ResultEvent,
  ): Promise<void> {
    try {
      await teardown;
    } catch (error) {
      // Transcript closure and terminal execution metadata are independent
      // durable facts; the terminal status still gets its own chance to land.
      logger.warn(
        'Waiting-execution cleanup failed; continuing terminal persistence',
        { data: { executionId: handle.executionId, error } },
      );
    }

    if (this.context.getHandle(handle.executionId) !== handle) {
      // `track` transfers the pending stop to a resumed successor. The old
      // handle still needs its private result settled, but it no longer owns
      // the shared stream, execution metadata, or lease.
      handle.settleResult(cancelledResult);
      return;
    }

    // Cleanup closes the suspended run's transcript group. Publish the
    // terminal state only after that owned artifact is settled so every host
    // observes one coherent cancellation boundary, and in one fixed order:
    // publish, settle the envelope, drop the handle, cancel the stream.
    handle.trace?.emit(cancelledResult);
    this.context.publishResult(cancelledResult, handle.childStreamId);
    handle.settleResult(cancelledResult);
    this.context.untrackHandle(handle);
    this.context.cancelStreamStatus(handle.childStreamId);

    try {
      const finalization = await finalizeRun({
        executionId: handle.executionId,
        outcome: RUN_OUTCOME.CANCELLED,
        // A stopped WAITING run is exactly what a user resumes. Deleting its
        // checkpoint here was the #11304 invariant's first violation (#11315).
        flowRecord: retainFlowRecordUnlessCompleted(RUN_OUTCOME.CANCELLED),
      });
      if (!finalization.ok) {
        logger.warn('Failed to finalize stopped waiting execution', {
          data: {
            executionId: handle.executionId,
            outcomePersisted: finalization.outcomePersisted,
            error: finalization.error,
          },
        });
      }
    } finally {
      if (!handle.isChildExecution) {
        try {
          await this.context.releaseRootExecutionLease(handle.executionId);
        } catch (error) {
          logger.warn('Waiting-execution artifact flush failed', {
            data: { executionId: handle.executionId, error },
          });
        }
      }
    }
  }
}
