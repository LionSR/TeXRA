/** Run status constants shared across agent runtime and UI layers. */
import { Cause } from 'effect';

import {
  type PositionAt,
  RUN_OUTCOME,
  RUN_PHASE,
  type RunOutcome,
  type RunLifecycleStatus,
} from '@shared/schemas';

// ============================================================================
// Run-outcome algebra
// ============================================================================
//
// `RunOutcome` is the canonical terminal fact, decided once at the run
// lifecycle boundary. The rule below is the only production mapping, and
// flows and hosts must not hand-roll their own.

/**
 * The one verdict of how a run that did not return ended, from its failure
 * cause: a stop outranks a failure, and any interrupt in the cause is a
 * stop, even when a finalizer then failed (`Interrupt` + `Die`), so every
 * terminal row agrees.
 */
export function outcomeFromCause(cause: Cause.Cause<unknown>): RunOutcome {
  return Cause.hasInterrupts(cause)
    ? RUN_OUTCOME.CANCELLED
    : RUN_OUTCOME.FAILED;
}

// ============================================================================
// RunPhase predicates
// ============================================================================

/** Whether a `RunPhase` is one of the three terminal outcome phases
 *  (COMPLETED | CANCELLED | FAILED). This is the single enumeration of that
 *  set — hosts must consume it rather than hand-rolling their own. */
export function isTerminalOutcomePhase(
  phase: RunLifecycleStatus | undefined,
): phase is RunOutcome {
  return (
    phase === RUN_PHASE.COMPLETED ||
    phase === RUN_PHASE.CANCELLED ||
    phase === RUN_PHASE.FAILED
  );
}

/** Whether transcript content is settled for the current turn. */
export function isTranscriptSettlementPhase(
  phase: RunLifecycleStatus | undefined,
): boolean {
  return phase === RUN_PHASE.WAITING || isTerminalOutcomePhase(phase);
}

export function isInFlightPhase(
  phase: RunLifecycleStatus | undefined,
): boolean {
  return phase === RUN_PHASE.RUNNING || phase === RUN_PHASE.WAITING;
}

/**
 * Where the loop stands, as its own branches read it: between turns
 * (`waiting`, `turn.ended`) or somewhere inside a turn. Never written: derived
 * from the run's `run.position` rows.
 */
export type RunLoopPhase =
  | 'model.ready'
  | 'model.submitted'
  | 'results.ready'
  | 'waiting'
  | 'turn.ended';

/**
 * The phase a position leaves an opened loop in. A stop writes no
 * position: the loop stops in the phase its newest position names, so a
 * resume continues from there. `turn.ready` is input consumed while
 * waiting, still between turns; a `turn.end` that no `waiting` or
 * `turn.begin` follows in its batch is the round loop's last round closed,
 * the run concluded before its terminal row. A run's first position opens
 * it: its opening batch's `turn.ready`, or a fork's `waiting`.
 */
const PHASE_AT: Readonly<Record<PositionAt, RunLoopPhase>> = {
  'turn.ready': 'waiting',
  'turn.begin': 'model.ready',
  'response.ready': 'model.submitted',
  'results.ready': 'results.ready',
  'turn.end': 'turn.ended',
  waiting: 'waiting',
};
export const phaseAfter = (
  phase: RunLoopPhase | null,
  at: PositionAt | null | undefined,
): RunLoopPhase | null => (at == null ? phase : PHASE_AT[at]);
