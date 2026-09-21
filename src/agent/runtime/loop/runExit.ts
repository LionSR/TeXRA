/**
 * The exit protocol both run programs share: the `halted` step every ending
 * run writes, and the error a failed run hands its caller. The two loops own
 * different finalizers — the tool-use loop also releases its follow-up lease
 * and can exit `waiting`, which the reflection loop has no concept of — but
 * the halt row and the failure mapping are one protocol, written once here so
 * the two families cannot drift apart on what a halted run records.
 */

import { Effect } from 'effect';
import type { AgentTrace } from '@agent/trace';
import type { RunId, RunOutcome } from '@shared/schemas';
import type { DatabaseWriteFailed } from '@shared/session/database';
import { RunLedger, RunLedgerRefused } from '@shared/session/runLedger';
import type { RunState } from '@shared/session/runStateFold';
import { ensureError } from '@utils/errors/errorMessage';

import { haltedStepRow, type StepCoordinates } from './rows';

/** The services the halt append needs, as both loops already hold them. */
interface HaltDeps {
  readonly ledger: RunLedger['Service'];
  readonly logger: AgentTrace;
  readonly runId: RunId;
}

/**
 * Appends the run's `halted` step for `outcome`. A run whose state never
 * opened (`null`, or a null `phase`) has no step to halt, so it writes
 * nothing. Recording the halt is best-effort by design: the run is already
 * ending, and raising here would replace its real outcome with a bookkeeping
 * failure, so a refused write is warned about instead.
 */
export const recordHalt =
  (
    deps: HaltDeps,
    state: RunState | null,
    toCoordinates: (state: RunState) => StepCoordinates,
  ) =>
  (outcome: RunOutcome): Effect.Effect<void, DatabaseWriteFailed> =>
    state === null || state.phase === null
      ? Effect.void
      : deps.ledger
          .appendBatch(deps.runId, state, [
            haltedStepRow(deps.runId, toCoordinates(state), outcome),
          ])
          .pipe(
            Effect.asVoid,
            Effect.catchIf(
              (error) => error instanceof RunLedgerRefused,
              (error) =>
                Effect.sync(() =>
                  deps.logger.warn('Failed to record the run halt', {
                    data: error,
                  }),
                ),
            ),
          );

/** The caller's error for a run that ended in a failure cause. */
export const runStopError = (error: unknown): Error =>
  error instanceof RunLedgerRefused
    ? new Error(
        `The run ledger refused a write (${error.reason}): ${error.detail}`,
        { cause: error },
      )
    : ensureError(error);
