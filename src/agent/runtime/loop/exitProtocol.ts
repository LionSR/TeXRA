/**
 * The run programs' exit protocol: what every loop's `Effect.onExit` and
 * `catchCause` do when a run stops, whatever the outcome. Shared here
 * because both `toolUse.ts` and `reflection.ts` hang this off `onExit`
 * rather than an `Effect.exit` followed by a masked block — an external
 * interrupt unwinds straight past `Effect.exit`, which would leave the
 * `halted` step unwritten — and a fix to that protocol applied to only one
 * loop is easy to miss in the other.
 */

import { Effect } from 'effect';
import type { AgentTrace } from '@agent/trace';
import type { RunId, RunOutcome } from '@shared/schemas';
import { RunLedger, RunLedgerRefused } from '@shared/session/runLedger';
import type { RunState } from '@shared/session/runStateFold';
import { ensureError } from '@utils/errors/errorMessage';

import { haltedStepRow } from './rows';

type StepCoordinates = Pick<
  RunState,
  'family' | 'round' | 'turn' | 'continuationIndex'
>;

/**
 * Records a run's `halted` step. A write failure only logs: the loop is
 * already unwinding when this runs, and has nothing left to surface it to.
 */
export function haltRun(
  runId: RunId,
  ledger: RunLedger['Service'],
  logger: AgentTrace,
  state: RunState | null,
  coordinatesOf: (state: RunState) => StepCoordinates,
  outcome: RunOutcome,
): Effect.Effect<void> {
  if (state === null || state.phase === null) return Effect.void;
  return ledger
    .appendBatch(runId, state, [
      haltedStepRow(runId, coordinatesOf(state), outcome),
    ])
    .pipe(
      Effect.catch((error) =>
        Effect.sync(() =>
          logger.warn('Failed to record the run halt', { data: error }),
        ),
      ),
    );
}

/** The caller's error for a run that ended in a failure cause. */
export function runExitFailure(error: unknown): Error {
  if (error instanceof RunLedgerRefused) {
    return new Error(
      `The run ledger refused a write (${error.reason}): ${error.detail}`,
      { cause: error },
    );
  }
  return ensureError(error);
}
