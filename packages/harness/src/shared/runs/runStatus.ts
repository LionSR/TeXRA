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
 * The one verdict of how a run ended, from its failure cause (none when it
 * returned) and what its driver saw besides: a stop outranks a failure, and
 * any interrupt in the cause is a stop, even when a finalizer then failed
 * (`Interrupt` + `Die`), so every terminal row agrees; a failure the run
 * reported without throwing is `failed`.
 */
export function outcomeFromCause(
  cause: Cause.Cause<unknown> | undefined,
  seen: { readonly stopped?: boolean; readonly failed?: boolean } = {},
): RunOutcome {
  if (
    seen.stopped === true ||
    (cause !== undefined && Cause.hasInterrupts(cause))
  )
    return RUN_OUTCOME.CANCELLED;
  return cause !== undefined || seen.failed === true
    ? RUN_OUTCOME.FAILED
    : RUN_OUTCOME.COMPLETED;
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

export function isActivePhase(phase: RunLifecycleStatus | undefined): boolean {
  return phase === RUN_PHASE.RUNNING;
}

export function isInFlightPhase(
  phase: RunLifecycleStatus | undefined,
): boolean {
  return phase === RUN_PHASE.RUNNING || phase === RUN_PHASE.WAITING;
}

/**
 * Where the loop stands, as its own branches read it: between turns
 * (`waiting`, `halted`) or somewhere inside a turn. Never written: derived
 * from the run's `run.position` rows.
 */
export type RunLoopPhase =
  'model.ready' | 'model.submitted' | 'results.ready' | 'waiting' | 'halted';

/**
 * The phase a position leaves an opened loop in. A `halted` position changes
 * none: a stop keeps the phase the loop stopped in, so a resume continues
 * from there. `turn.ready` is input consumed while waiting, still between
 * turns; a `turn.end` that no `waiting` or `turn.begin` follows in its batch
 * is the round loop's last round closed, the run concluded before its
 * terminal row. A run's first position opens it: its opening batch's
 * `turn.ready`, or a fork's `waiting`. A halt opens nothing.
 */
const PHASE_AT: Readonly<Record<Exclude<PositionAt, 'halted'>, RunLoopPhase>> =
  {
    'turn.ready': 'waiting',
    'turn.begin': 'model.ready',
    'response.ready': 'model.submitted',
    'results.ready': 'results.ready',
    'turn.end': 'halted',
    waiting: 'waiting',
  };
export const phaseAfter = (
  phase: RunLoopPhase | null,
  at: PositionAt | null | undefined,
): RunLoopPhase | null =>
  at == null || at === 'halted' ? phase : PHASE_AT[at];
