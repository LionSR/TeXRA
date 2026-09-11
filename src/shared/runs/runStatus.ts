/** Stream status constants shared across agent runtime and UI layers. */
import {
  CLI_RUN_STATUS,
  RUN_OUTCOME,
  RUN_PHASE,
  type CliRunStatus,
  type RunOutcome,
  type RunPhase,
  type RunLifecycleStatus,
} from '@shared/schemas';

// ============================================================================
// Run-outcome algebra
// ============================================================================
//
// `RunOutcome` is the canonical terminal fact, decided once at the run
// lifecycle boundary. The derivation rule and persisted run-status
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
 * Project the canonical outcome onto the frozen public run-status
 * vocabulary (CLI NDJSON history status, CLI display prose).
 * The only production mapping — flows and hosts must not hand-roll their
 * own. An out-of-vocabulary value (stale fixture, unparsed legacy data)
 * fails with a named error instead of an undefined-property crash
 * downstream.
 */
export function runOutcomeToCliRunStatus(outcome: RunOutcome): CliRunStatus {
  switch (outcome) {
    case RUN_OUTCOME.COMPLETED:
      return CLI_RUN_STATUS.COMPLETED;
    case RUN_OUTCOME.CANCELLED:
      return CLI_RUN_STATUS.INTERRUPTED;
    case RUN_OUTCOME.FAILED:
      return CLI_RUN_STATUS.ERROR;
    default:
      throw new Error(`Unhandled run outcome: ${String(outcome)}`);
  }
}

// ============================================================================
// RunPhase transition algebra (stage 0 vocabulary only)
// ============================================================================

export const RUN_TRANSITION_CAUSE = {
  LIFECYCLE: 'lifecycle',
  WAIT: 'wait',
  RESUME: 'resume',
  USER_STOP: 'user-stop',
} as const;

export type RunTransitionCause =
  (typeof RUN_TRANSITION_CAUSE)[keyof typeof RUN_TRANSITION_CAUSE];

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
 * Whether a workflow-script run has ended, as the shared workflow run model
 * reads it off `runPhase`: a known status that is neither running nor
 * waiting. An unknown status is not "ended" — a plan-only phase must not
 * vanish before the stream's first status has arrived. This is the looser of
 * the model's two readings: `unavailable` (a run another process owns) counts
 * as ended here, which is why the model repaints a running card only on the
 * stricter `isTerminalOutcomePhase`.
 */
export function workflowRunSettled(
  phase: RunLifecycleStatus | undefined,
): boolean {
  return phase !== undefined && !isInFlightPhase(phase);
}

export function canTransitionRunPhase(
  from: RunPhase | undefined,
  to: RunPhase,
  cause: RunTransitionCause,
): boolean {
  if (cause === RUN_TRANSITION_CAUSE.USER_STOP) {
    return (
      (from === undefined || isInFlightPhase(from)) &&
      to === RUN_PHASE.CANCELLED
    );
  }

  if (isTerminalOutcomePhase(from)) {
    return cause === RUN_TRANSITION_CAUSE.RESUME && to === RUN_PHASE.RUNNING;
  }

  switch (cause) {
    case RUN_TRANSITION_CAUSE.LIFECYCLE:
      if (from === undefined) return to === RUN_PHASE.RUNNING;
      return from === RUN_PHASE.RUNNING && isTerminalOutcomePhase(to);
    case RUN_TRANSITION_CAUSE.WAIT:
      return from === RUN_PHASE.RUNNING && to === RUN_PHASE.WAITING;
    case RUN_TRANSITION_CAUSE.RESUME:
      // WAITING terminalization is explicit choreography: WAITING resumes to
      // RUNNING, then lifecycle writes the terminal outcome. RUNNING->RUNNING
      // clears display-only resume substate through the same table-checked path.
      return (
        (from === undefined ||
          from === RUN_PHASE.WAITING ||
          from === RUN_PHASE.RUNNING) &&
        to === RUN_PHASE.RUNNING
      );
  }
}
