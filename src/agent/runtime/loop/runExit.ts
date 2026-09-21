/**
 * The exit protocol both run programs share: the `halted` step every ending
 * run writes, and the error a failed run hands its caller. The two loops own
 * different finalizers — the tool-use loop also releases its follow-up lease
 * and can exit `waiting`, which the reflection loop has no concept of — but
 * the halt row and the failure mapping are one protocol, written once here so
 * the two families cannot drift apart on what a halted run records.
 */

import { Cause, Effect, Option, Result } from 'effect';
import type { AgentTrace } from '@agent/trace';
import type { RunId, RunOutcome } from '@shared/schemas';
import { DatabaseWriteFailed } from '@shared/session/database';
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

type HaltWriteFailure = RunLedgerRefused | DatabaseWriteFailed;
type HaltWriteResolution =
  | { readonly kind: 'warn'; readonly error: RunLedgerRefused }
  | { readonly kind: 'fail'; readonly error: DatabaseWriteFailed }
  | { readonly kind: 'die'; readonly defect: unknown };

function classifyHaltWriteCause(
  cause: Cause.Cause<HaltWriteFailure>,
): HaltWriteResolution {
  const failure = Cause.findErrorOption(cause);
  if (Option.isSome(failure)) {
    if (failure.value instanceof RunLedgerRefused) {
      return { kind: 'warn', error: failure.value };
    }
    if (failure.value instanceof DatabaseWriteFailed) {
      return { kind: 'fail', error: failure.value };
    }
  }

  const defect = Cause.findDefect(cause);
  if (Result.isSuccess(defect)) {
    if (defect.success instanceof RunLedgerRefused) {
      return { kind: 'warn', error: defect.success };
    }
    if (defect.success instanceof DatabaseWriteFailed) {
      return { kind: 'fail', error: defect.success };
    }
    return { kind: 'die', defect: defect.success };
  }

  return { kind: 'die', defect: Cause.squash(cause) };
}

/**
 * Appends the run's `halted` step for `outcome`. A run whose state never
 * opened (`null`, or a null `phase`) has no step to halt, so it writes
 * nothing. A refused ledger write is best-effort by design: the run is already
 * ending, and raising here would replace its real outcome with a bookkeeping
 * failure, so `RunLedgerRefused` is warned about instead. Other database write
 * failures still fail normally.
 */
export const recordHalt =
  (
    deps: HaltDeps,
    toCoordinates: (state: RunState) => StepCoordinates,
  ) =>
  (
    state: RunState | null,
    outcome: RunOutcome,
  ): Effect.Effect<void, DatabaseWriteFailed> =>
    state === null || state.phase === null
      ? Effect.void
      : deps.ledger
          .appendBatch(deps.runId, state, [
            haltedStepRow(deps.runId, toCoordinates(state), outcome),
          ])
          .pipe(
            Effect.asVoid,
            Effect.catchCause((cause) => {
              const resolution = classifyHaltWriteCause(cause);
              return resolution.kind === 'warn'
                ? Effect.sync(() =>
                    deps.logger.warn('Failed to record the run halt', {
                      data: resolution.error,
                    }),
                  )
                : resolution.kind === 'fail'
                  ? Effect.fail(resolution.error)
                  : Effect.die(resolution.defect);
            }),
          );

/** The caller's error for a run that ended in a failure cause. */
export const runStopError = (error: unknown): Error =>
  error instanceof RunLedgerRefused
    ? new Error(
        `The run ledger refused a write (${error.reason}): ${error.detail}`,
        { cause: error },
      )
    : ensureError(error);
