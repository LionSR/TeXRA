/**
 * Stream status constants shared across agent runtime and UI layers.
 */
// Local imports - shared schemas
import {
  EXECUTION_STATUS,
  RUN_OUTCOME,
  STREAM_PHASE,
  type ExecutionStatus,
  type RunOutcome,
  type StreamPhase,
  type StreamLifecycleStatus,
} from '@shared/schemas';

// ============================================================================
// Run-outcome algebra
// ============================================================================
//
// `RunOutcome` is the canonical terminal fact, decided once at the run
// lifecycle boundary. The derivation rule and persisted execution-status
// projection below are the only production mappings — flows and hosts must
// not hand-roll their own. Legacy transcript/stream values are accepted and
// normalized only at their parse-side compatibility boundaries.

/**
 * The single facts → outcome derivation rule, shared by every flow exit.
 * Priority: failed > cancelled > completed.
 */
export function deriveRunOutcome(facts: {
  readonly failed: boolean;
  readonly cancelled: boolean;
}): RunOutcome {
  if (facts.failed) return RUN_OUTCOME.FAILED;
  if (facts.cancelled) return RUN_OUTCOME.CANCELLED;
  return RUN_OUTCOME.COMPLETED;
}

export interface RunOutcomeProjection {
  /** Export-boundary projection (trace document `terminalStatus`). */
  readonly executionStatus: ExecutionStatus;
}

/**
 * Projection table: one row per outcome for persisted execution status.
 *
 * `executionStatus` keeps all three outcomes distinct at the frozen public
 * boundaries (trace document `terminalStatus`, CLI NDJSON history status).
 * Retired transcript and stream vocabularies are not projected here:
 * permanent parse-side readers accept those legacy values and normalize them
 * to canonical current values.
 *
 * The `Record` key type keeps the table compile-time exhaustive; read it
 * through {@link projectRunOutcome} so an out-of-vocabulary value (stale
 * fixture, unparsed legacy data) fails with a named error instead of an
 * undefined-property crash downstream.
 */
export const RUN_OUTCOME_PROJECTION: Readonly<
  Record<RunOutcome, RunOutcomeProjection>
> = {
  [RUN_OUTCOME.COMPLETED]: {
    executionStatus: EXECUTION_STATUS.COMPLETED,
  },
  [RUN_OUTCOME.CANCELLED]: {
    executionStatus: EXECUTION_STATUS.INTERRUPTED,
  },
  [RUN_OUTCOME.FAILED]: {
    executionStatus: EXECUTION_STATUS.ERROR,
  },
};

/** Guarded table read — loud, named failure on an unhandled outcome. */
export function projectRunOutcome(outcome: RunOutcome): RunOutcomeProjection {
  const projection = RUN_OUTCOME_PROJECTION[outcome];
  if (!projection) {
    throw new Error(`Unhandled run outcome: ${String(outcome)}`);
  }
  return projection;
}

export function runOutcomeToExecutionStatus(
  outcome: RunOutcome,
): ExecutionStatus {
  return projectRunOutcome(outcome).executionStatus;
}

// ============================================================================
// StreamPhase transition algebra (stage 0 vocabulary only)
// ============================================================================

export const STREAM_TRANSITION_CAUSE = {
  LIFECYCLE: 'lifecycle',
  RESERVATION_ROLLBACK: 'reservation-rollback',
  WAIT: 'wait',
  RESUME: 'resume',
  USER_STOP: 'user-stop',
  RESTART_REPAIR: 'restart-repair',
} as const;

export type StreamTransitionCause =
  (typeof STREAM_TRANSITION_CAUSE)[keyof typeof STREAM_TRANSITION_CAUSE];

/** Whether a `StreamPhase` is one of the three terminal outcome phases
 *  (COMPLETED | CANCELLED | FAILED). This is the single enumeration of that
 *  set — hosts must consume it rather than hand-rolling their own. */
export function isTerminalOutcomePhase(
  phase: StreamLifecycleStatus | undefined,
): phase is RunOutcome {
  return (
    phase === STREAM_PHASE.COMPLETED ||
    phase === STREAM_PHASE.CANCELLED ||
    phase === STREAM_PHASE.FAILED
  );
}

/** Whether transcript content is settled for the current turn. */
export function isTranscriptSettlementPhase(
  phase: StreamLifecycleStatus | undefined,
): boolean {
  return phase === STREAM_PHASE.WAITING || isTerminalOutcomePhase(phase);
}

export function isActivePhase(phase: StreamPhase | undefined): boolean {
  return phase === STREAM_PHASE.RUNNING;
}

export function isInFlightPhase(phase: StreamPhase | undefined): boolean {
  return phase === STREAM_PHASE.RUNNING || phase === STREAM_PHASE.WAITING;
}

export function canAcquireStreamReservation(
  phase: StreamPhase | undefined,
): boolean {
  return !isInFlightPhase(phase);
}

export function canTransitionStreamPhase(
  from: StreamPhase | undefined,
  to: StreamPhase,
  cause: StreamTransitionCause,
): boolean {
  if (cause === STREAM_TRANSITION_CAUSE.USER_STOP) {
    return (
      (from === undefined || isInFlightPhase(from)) &&
      to === STREAM_PHASE.CANCELLED
    );
  }

  if (isTerminalOutcomePhase(from)) {
    return (
      cause === STREAM_TRANSITION_CAUSE.RESUME && to === STREAM_PHASE.RUNNING
    );
  }

  switch (cause) {
    case STREAM_TRANSITION_CAUSE.LIFECYCLE:
      if (from === undefined) return to === STREAM_PHASE.RUNNING;
      return from === STREAM_PHASE.RUNNING && isTerminalOutcomePhase(to);
    case STREAM_TRANSITION_CAUSE.RESERVATION_ROLLBACK:
      return from === STREAM_PHASE.RUNNING && isTerminalOutcomePhase(to);
    case STREAM_TRANSITION_CAUSE.WAIT:
      return from === STREAM_PHASE.RUNNING && to === STREAM_PHASE.WAITING;
    case STREAM_TRANSITION_CAUSE.RESUME:
      // WAITING terminalization is explicit choreography: WAITING resumes to
      // RUNNING, then lifecycle writes the terminal outcome. RUNNING->RUNNING
      // clears display-only resume substate through the same table-checked path.
      return (
        (from === undefined ||
          from === STREAM_PHASE.WAITING ||
          from === STREAM_PHASE.RUNNING) &&
        to === STREAM_PHASE.RUNNING
      );
    case STREAM_TRANSITION_CAUSE.RESTART_REPAIR:
      if (from === undefined) return true;
      if (from === to) return true;
      return (
        from === STREAM_PHASE.RUNNING &&
        (to === STREAM_PHASE.WAITING ||
          to === STREAM_PHASE.FAILED ||
          to === STREAM_PHASE.CANCELLED)
      );
  }
}
