/**
 * Termination cascade for suspended runs.
 *
 * Tears down an `RunHandle` parked at WAITING with no live
 * interrupt context: writes the `run.end` row, settles `handle.result`, and
 * releases the run lease, all on behalf of `RunRegistry.terminate`.
 */

import { Cause, Effect, Exit } from 'effect';

import { createChannelTrace, type ResultEvent } from '@agent/trace';
import { RunLeaseLostError } from '@agent/storage/runLease';
import {
  type FinalizeRunInput,
  type FinalizeRunResult,
  retainFlowRecordUnlessCompleted,
} from '@agent/storage/runLifecycle';
import { emptyRunEndOutput, RUN_OUTCOME, type RunId } from '@shared/schemas';
import { ensureError } from '@utils/errors/errorMessage';
import type { RunHandle } from './RunHandle';
import type { RunLanes } from './runLanes';

const logger = createChannelTrace('runRegistry');

/**
 * The registry-owned collaborators the waiting-termination cascade needs,
 * injected so the registry stays the single owner of handles, stream status,
 * and the session's lease-release boundary.
 */
export interface WaitingTerminationContext {
  readonly releaseRootRunLease: (runId: RunId) => Effect.Effect<void, Error>;
  readonly finalizeRun: (
    input: FinalizeRunInput,
  ) => Effect.Effect<FinalizeRunResult, Error>;
  readonly lanes: RunLanes;
  readonly getHandle: (runId: RunId) => RunHandle | undefined;
  readonly untrackIfCurrent: (handle: RunHandle) => boolean;
  readonly untrackHandle: (handle: RunHandle) => void;
  readonly cancelRunStatus: (runId: RunId) => void;
}

export class WaitingTermination {
  constructor(private readonly context: WaitingTerminationContext) {}

  /**
   * Tear down an `RunHandle` parked at WAITING with no live
   * interrupt context, returning whether this stop claimed the run.
   *
   * The handle's own suspension is the single authority on both questions this
   * path used to cross-check: `runFlowWithLifecycle`'s WAITING branch is what
   * parks a handle, and `beginSuspendedTermination` claims the run's terminal
   * outcome in one synchronous step. The returned native settlement owns
   * teardown and holds the run lane until completion. So a handle that
   * never parked (one merely between its own interrupt-handler detach and
   * untrack during normal teardown) and a run whose terminal outcome
   * `finalizeRunTerminal` already claimed both leave this a no-op, with no
   * `runStatus` re-read: a stop can neither abandon a live run nor publish
   * a second outcome. That also covers the window
   * `resumeQueuedToolUse` (`resumeRun.ts`) opens by flipping the stream to
   * RUNNING/RESUMING before the resumed run installs its own context — the
   * suspended handle it replaces is still parked, so a stop landing there
   * still tears the stalled resume down.
   *
   * This path bypasses `runFlowWithLifecycle`'s own terminal handling (the
   * flow never resumes to produce one), so it writes the `run.end` row through
   * `finalizeRun` and settles `handle.result` itself — otherwise session
   * subscribers would miss the stop, a consumer awaiting `handle.result` (F-2)
   * would hang forever, and the run's history would keep a non-terminal
   * status. Unlike `finalizeRunTerminal`, no usage totals ride the row: the
   * flow is suspended, so there is no live usage monitor to read.
   */
  terminateWaitingHandle(handle: RunHandle): Effect.Effect<void> | undefined {
    const teardown = handle.beginSuspendedTermination();
    if (!teardown) return undefined;
    const cancelledResult: ResultEvent = {
      type: 'run.end',
      outcome: RUN_OUTCOME.CANCELLED,
      runId: handle.runId,
      output: emptyRunEndOutput(handle.category),
    };
    return this.context.lanes.holdLive(
      handle.runId,
      this.finishWaitingTermination(handle, teardown, cancelledResult).pipe(
        Effect.catchCause((cause) =>
          Effect.gen({ self: this }, function* () {
            const error = Cause.squash(cause);
            // Durable finalization never ran, so recovery only settles what this
            // generation privately owns. Each step is guarded on its own: a failure
            // in one must not cost the others. A former generation owns only its
            // private result, it must not mark, release, untrack, or cancel a
            // locally reacquired successor, which is what `untrackIfCurrent` gates.
            const recoveryFailures: unknown[] = [error];
            let untracked = false;
            const settled = yield* Effect.exit(
              Effect.try({
                try: () => handle.settleResult(cancelledResult),
                catch: ensureError,
              }),
            );
            if (Exit.isFailure(settled)) {
              recoveryFailures.push(Cause.squash(settled.cause));
            }
            const untracking = yield* Effect.exit(
              Effect.try({
                try: () => {
                  untracked = this.context.untrackIfCurrent(handle);
                  if (untracked) {
                    this.context.cancelRunStatus(handle.runId);
                  }
                },
                catch: ensureError,
              }),
            );
            if (Exit.isFailure(untracking)) {
              recoveryFailures.push(Cause.squash(untracking.cause));
            }
            // A lost lease is already gone: releasing it would reach whatever holds
            // the record now. Every other failure still owes the release.
            if (
              untracked &&
              !handle.isChild &&
              !(error instanceof RunLeaseLostError)
            ) {
              const released = yield* Effect.exit(
                this.context.releaseRootRunLease(handle.runId),
              );
              if (Exit.isFailure(released))
                recoveryFailures.push(
                  ensureError(Cause.squash(released.cause)),
                );
            }
            logger.warn(
              'Waiting-run termination failed; settled the run without durable finalization',
              { data: { runId: handle.runId, recoveryFailures } },
            );
          }),
        ),
        Effect.uninterruptible,
      ),
    );
  }

  private readonly finishWaitingTermination = Effect.fn(
    'finishWaitingTermination',
  )(function* (
    this: WaitingTermination,
    handle: RunHandle,
    teardown: Effect.Effect<void, Error>,
    cancelledResult: ResultEvent,
  ) {
    yield* teardown.pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          const error = ensureError(Cause.squash(cause));
          // Transcript closure and terminal run metadata are independent
          // durable facts; the terminal status still gets its own chance to land.
          logger.warn(
            'Waiting-run cleanup failed; continuing terminal persistence',
            { data: { runId: handle.runId, error } },
          );
        }),
      ),
    );

    if (this.context.getHandle(handle.runId) !== handle) {
      // `track` transfers the pending stop to a resumed successor. The old
      // handle still needs its private result settled, but it no longer owns
      // the shared stream, run metadata, or lease.
      handle.settleResult(cancelledResult);
      return;
    }

    // Cleanup closes the suspended run's transcript group. Write the terminal
    // row only after that owned artifact is settled so every host observes
    // one coherent cancellation boundary, and in one fixed order: write the
    // row, settle the envelope, drop the handle, cancel the stream.
    const finalize = Effect.gen({ self: this }, function* () {
      const finalization = yield* this.context.finalizeRun({
        runId: handle.runId,
        outcome: RUN_OUTCOME.CANCELLED,
        output: cancelledResult.output,
        // A stopped WAITING run is exactly what a user resumes. Deleting its
        // checkpoint here was the #11304 invariant's first violation (#11315).
        flowRecord: retainFlowRecordUnlessCompleted(RUN_OUTCOME.CANCELLED),
      });
      if (!finalization.ok) {
        logger.warn('Failed to finalize stopped waiting run', {
          data: {
            runId: handle.runId,
            outcomePersisted: finalization.outcomePersisted,
            error: finalization.error,
          },
        });
      }
      handle.settleResult(cancelledResult);
      this.context.untrackHandle(handle);
      this.context.cancelRunStatus(handle.runId);
    });
    return yield* finalize.pipe(
      Effect.ensuring(
        handle.isChild
          ? Effect.void
          : this.context.releaseRootRunLease(handle.runId).pipe(
              Effect.catch((error) =>
                Effect.sync(() => {
                  logger.warn('Waiting-run artifact flush failed', {
                    data: { runId: handle.runId, error },
                  });
                }),
              ),
            ),
      ),
    );
  });
}
