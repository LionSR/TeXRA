/**
 * Stream status constants shared across agent runtime and UI layers.
 */
// Local imports - shared schemas
import {
  EXECUTION_STATUS,
  RUN_OUTCOME,
  STREAM_STATUS,
  STREAM_STATUS_TRAITS,
  streamStatusesWithTrait,
  type ExecutionStatus,
  type RunOutcome,
  type StreamStatus,
} from '@shared/schemas';

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
  /** Transcript-group projection (`stage.end()` / group-end rows). */
  readonly endGroupStatus: 'error' | 'stopped';
  /** Live stream-state projection for the terminal transition. */
  readonly streamStatus: StreamStatus;
}

/**
 * Projection table: one row per outcome, one column per legacy vocabulary.
 *
 * Reading the columns:
 * - `executionStatus` is the only injective projection — persisted history
 *   keeps all three outcomes apart.
 * - `endGroupStatus` and `streamStatus` are isomorphic (completed/cancelled
 *   fold to the same neutral value; only failed is distinct): a cancelled run
 *   ends neutral, never red — a user stop is not a failure. If the transcript
 *   group vocabulary ever learns a third value, consolidate these two columns
 *   into one.
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
    endGroupStatus: 'stopped',
    streamStatus: STREAM_STATUS.STOPPED,
  },
  [RUN_OUTCOME.CANCELLED]: {
    executionStatus: EXECUTION_STATUS.INTERRUPTED,
    endGroupStatus: 'stopped',
    streamStatus: STREAM_STATUS.STOPPED,
  },
  [RUN_OUTCOME.FAILED]: {
    executionStatus: EXECUTION_STATUS.ERROR,
    endGroupStatus: 'error',
    streamStatus: STREAM_STATUS.ERROR,
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

// ============================================================================
// Status trait predicates (derived from STREAM_STATUS_TRAITS)
// ============================================================================
//
// Membership lives in the declarative trait table in `@shared/schemas`
// (`STREAM_STATUS_TRAITS`); these are thin readers over it. Do not declare
// new status lists by hand — add a trait column instead.

/**
 * Terminal statuses — stream execution has ended and won't resume
 * automatically. Used by status bar to determine running vs idle state.
 */
export const TERMINAL_STATUSES: readonly StreamStatus[] = [
  ...streamStatusesWithTrait('terminal'),
];

/** Check if a status indicates active execution (running or resuming). */
export function isActiveStatus(status: StreamStatus | undefined): boolean {
  return status !== undefined && STREAM_STATUS_TRAITS[status].active;
}

/**
 * Statuses during which an agent cycle may still be appending to the stream
 * and it must not be evicted from memory or acquired by a new run.
 */
export function isInFlightStatus(status: StreamStatus | undefined): boolean {
  return status !== undefined && STREAM_STATUS_TRAITS[status].inFlight;
}

/** Check if a status is terminal (execution ended). */
export function isTerminalStatus(status: StreamStatus | undefined): boolean {
  return status !== undefined && STREAM_STATUS_TRAITS[status].terminal;
}
