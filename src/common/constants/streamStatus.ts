/**
 * Stream status constants shared across agent runtime and UI layers.
 */
// Local imports - shared schemas
import {
  EXECUTION_STATUS,
  RUN_OUTCOME,
  STREAM_STATUS,
  type ExecutionStatus,
  type RunOutcome,
  type StreamStatus,
} from '@shared/schemas';

// ============================================================================
// Run-outcome projections
// ============================================================================
//
// `RunOutcome` is the canonical terminal fact, decided once at the run
// lifecycle boundary. These projections are the ONLY place the legacy
// vocabularies are derived from it — flows and hosts must not hand-roll
// their own mappings.

/** Persisted-history projection (`ExecutionMeta.terminalStatus`). */
export function outcomeToExecutionStatus(outcome: RunOutcome): ExecutionStatus {
  switch (outcome) {
    case RUN_OUTCOME.COMPLETED:
      return EXECUTION_STATUS.COMPLETED;
    case RUN_OUTCOME.CANCELLED:
      return EXECUTION_STATUS.INTERRUPTED;
    case RUN_OUTCOME.FAILED:
      return EXECUTION_STATUS.ERROR;
  }
}

/**
 * Transcript-group projection (`stage.end()` / group-end rows).
 * A cancelled run ends its group neutral like a completed one — a user stop
 * is not a failure and must not paint the transcript red.
 */
export function outcomeToEndGroupStatus(
  outcome: RunOutcome,
): 'error' | 'stopped' {
  return outcome === RUN_OUTCOME.FAILED ? 'error' : 'stopped';
}

/** Live stream-state projection for the terminal transition. */
export function outcomeToStreamStatus(outcome: RunOutcome): StreamStatus {
  return outcome === RUN_OUTCOME.FAILED
    ? STREAM_STATUS.ERROR
    : STREAM_STATUS.STOPPED;
}

// ============================================================================
// Status Helper Functions
// ============================================================================

/**
 * Terminal statuses - stream execution has ended and won't resume automatically.
 * Used by status bar to determine running vs idle state.
 *
 * Includes:
 * - STOPPED: Flow completed successfully
 * - ERROR: Flow failed due to error
 * - WAITING: Flow paused awaiting user input (follow-up, retry decision).
 *   Classified as terminal because the current execution cycle has ended -
 *   resumption requires explicit user action, not automatic continuation.
 * - READY: Initial state, no execution started
 *
 * Note: INITIALIZING is intentionally excluded - it's a brief transitional state
 * during workflow launch that will quickly become RUNNING or fail. It's neither
 * terminal (execution hasn't ended) nor actively processing (no model calls yet).
 */
const TERMINAL_STATUSES: readonly StreamStatus[] = [
  STREAM_STATUS.STOPPED,
  STREAM_STATUS.ERROR,
  STREAM_STATUS.WAITING,
  STREAM_STATUS.READY,
] as const;

/**
 * Check if a status indicates active execution (running or resuming).
 * This is the single source of truth for "active" status checks.
 *
 * Note: INITIALIZING is not considered active - it's a transitional state
 * before execution actually begins. Use StreamStatusService.tryAcquire()
 * to check for both INITIALIZING and active states when guarding against
 * concurrent operations.
 */
export function isActiveStatus(status: StreamStatus | undefined): boolean {
  return status === STREAM_STATUS.RUNNING || status === STREAM_STATUS.RESUMING;
}

/**
 * Statuses during which an agent cycle may still be appending to the stream
 * and it must not be evicted from memory or acquired by a new run. Superset
 * of {@link isActiveStatus} — also covers INITIALIZING (pre-start) and
 * WAITING (paused on user input; follow-up appends to the same log).
 */
const IN_FLIGHT_STATUSES: ReadonlySet<StreamStatus> = new Set<StreamStatus>([
  STREAM_STATUS.RUNNING,
  STREAM_STATUS.RESUMING,
  STREAM_STATUS.INITIALIZING,
  STREAM_STATUS.WAITING,
]);

export function isInFlightStatus(status: StreamStatus | undefined): boolean {
  return status !== undefined && IN_FLIGHT_STATUSES.has(status);
}

/**
 * Check if a status is terminal (execution ended).
 */
export function isTerminalStatus(status: StreamStatus | undefined): boolean {
  return status !== undefined && TERMINAL_STATUSES.includes(status);
}
