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

/**
 * Project the canonical outcome onto the frozen public execution-status
 * vocabulary (CLI NDJSON history status, CLI display prose).
 * The only production mapping — flows and hosts must not hand-roll their
 * own. An out-of-vocabulary value (stale fixture, unparsed legacy data)
 * fails with a named error instead of an undefined-property crash
 * downstream.
 */
export function runOutcomeToExecutionStatus(
  outcome: RunOutcome,
): ExecutionStatus {
  switch (outcome) {
    case RUN_OUTCOME.COMPLETED:
      return EXECUTION_STATUS.COMPLETED;
    case RUN_OUTCOME.CANCELLED:
      return EXECUTION_STATUS.INTERRUPTED;
    case RUN_OUTCOME.FAILED:
      return EXECUTION_STATUS.ERROR;
    default:
      throw new Error(`Unhandled run outcome: ${String(outcome)}`);
  }
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

export function isActivePhase(
  phase: StreamLifecycleStatus | undefined,
): boolean {
  return phase === STREAM_PHASE.RUNNING;
}

export function isInFlightPhase(
  phase: StreamLifecycleStatus | undefined,
): boolean {
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
      // Repair settles a stream on a persisted outcome or records an
      // interruption as CANCELLED; it never restores a live phase it did not
      // observe and never infers FAILED.
      if (from === undefined) return isTerminalOutcomePhase(to);
      if (from === to) return true;
      return from === STREAM_PHASE.RUNNING && to === STREAM_PHASE.CANCELLED;
  }
}
