/**
 * Stream status constants shared across agent runtime and UI layers.
 */
// Local imports - shared schemas
import {
  EXECUTION_STATUS,
  RUN_OUTCOME,
  STREAM_PHASE,
  STREAM_STATUS,
  STREAM_STATUS_TRAITS,
  StreamPhaseSchema,
  type ExecutionStatus,
  type RunOutcome,
  type StreamPhase,
  type StreamStatus,
  type StreamStatusTrait,
} from '@shared/schemas/stream';

// ============================================================================
// Run-outcome algebra
// ============================================================================
//
// `RunOutcome` is the canonical terminal fact, decided once at the run
// lifecycle boundary. The declarative tables below are the ONLY places the
// derivation rule and the legacy-vocabulary projections are defined — flows
// and hosts must not hand-roll their own mappings.

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
  /** Persisted-history projection (`ExecutionMeta.terminalStatus`). */
  readonly executionStatus: ExecutionStatus;
}

/**
 * Projection table: one row per outcome, one injective legacy vocabulary.
 *
 * `executionStatus` is the only injective projection — persisted history keeps
 * all three outcomes apart. The non-injective legacy transcript/stream shapes
 * are derived by helpers below so the completed/cancelled fold has one source.
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

export function groupEndStatusForOutcome(outcome: RunOutcome): 'ok' | 'error' {
  return outcome === RUN_OUTCOME.FAILED ? 'error' : 'ok';
}

export function legacyEndGroupStatusForOutcome(
  outcome: RunOutcome,
): 'error' | 'stopped' {
  return groupEndStatusForOutcome(outcome) === 'error' ? 'error' : 'stopped';
}

export function terminalStreamStatusForOutcome(
  outcome: RunOutcome,
): StreamStatus {
  return groupEndStatusForOutcome(outcome) === 'error'
    ? STREAM_STATUS.ERROR
    : STREAM_STATUS.STOPPED;
}

// ============================================================================
// StreamPhase transition algebra (stage 0 vocabulary only)
// ============================================================================

export const STREAM_TRANSITION_CAUSE = {
  LIFECYCLE: 'lifecycle',
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
  phase: StreamPhase | undefined,
): phase is RunOutcome {
  return (
    phase === STREAM_PHASE.COMPLETED ||
    phase === STREAM_PHASE.CANCELLED ||
    phase === STREAM_PHASE.FAILED
  );
}

export function isActivePhase(phase: StreamPhase | undefined): boolean {
  return phase === STREAM_PHASE.RUNNING;
}

export function isInFlightPhase(phase: StreamPhase | undefined): boolean {
  return phase === STREAM_PHASE.RUNNING || phase === STREAM_PHASE.WAITING;
}

function isTerminalPhase(phase: StreamPhase | undefined): boolean {
  return phase === STREAM_PHASE.WAITING || isTerminalOutcomePhase(phase);
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

// ============================================================================
// Status trait predicates (derived from STREAM_STATUS_TRAITS)
// ============================================================================
//
// Membership lives in the declarative trait table in `@shared/schemas/stream`
// (`STREAM_STATUS_TRAITS`); these are thin readers over it. Do not declare
// new status lists by hand — add a trait column instead.

/** Shared trait lookup: a `StreamPhase` value parses straight to the phase
 *  predicate, otherwise falls back to the legacy `StreamStatus` trait table. */
function hasStatusTrait(
  status: string | undefined,
  phasePredicate: (phase: StreamPhase | undefined) => boolean,
  trait: StreamStatusTrait,
): boolean {
  const phase = StreamPhaseSchema.safeParse(status);
  if (phase.success) return phasePredicate(phase.data);
  return (
    status !== undefined &&
    Object.hasOwn(STREAM_STATUS_TRAITS, status) &&
    STREAM_STATUS_TRAITS[status as StreamStatus][trait]
  );
}

/** Check if a status indicates active execution (running or resuming). */
export function isActiveStatus(status: string | undefined): boolean {
  return hasStatusTrait(status, isActivePhase, 'active');
}

/**
 * Statuses during which an agent cycle may still be appending to the stream
 * and it must not be evicted from memory or acquired by a new run.
 */
export function isInFlightStatus(status: string | undefined): boolean {
  return hasStatusTrait(status, isInFlightPhase, 'inFlight');
}

/** Check if a status is terminal (execution ended). */
export function isTerminalStatus(status: string | undefined): boolean {
  return hasStatusTrait(status, isTerminalPhase, 'terminal');
}

/** Check if elapsed-time displays should keep advancing for this status. */
export function isLiveElapsedStatus(status: string | undefined): boolean {
  return hasStatusTrait(
    status,
    (phase) => phase === STREAM_PHASE.RUNNING,
    'liveElapsed',
  );
}
