/**
 * Stream status constants shared across agent runtime and UI layers.
 */
// Local imports - shared schemas
import {
  EXECUTION_STATUS,
  STREAM_STATUS,
  type ExecutionStatus,
  type StreamStatus,
} from '@shared/schemas';

// ============================================================================
// Execution Status - Flow-Level Completion Status
// ============================================================================

/**
 * Execution status - flow-level completion states.
 * Single source of truth for flow execution results.
 *
 * This is the internal status used by flow implementations (PersistedFlow,
 * RoundPersistedFlow) to communicate how execution ended. It captures
 * more semantic detail than EndGroupStatus:
 *
 * - `completed`: Flow ran to natural completion (all rounds finished)
 * - `interrupted`: Flow was stopped by user/system before completion
 * - `error`: Flow failed due to an error
 *
 * Use toEndGroupStatus() to convert to logger-compatible status.
 */
export { EXECUTION_STATUS, STREAM_STATUS };

// ============================================================================
// Status Transformation Functions
// ============================================================================

/**
 * Convert ExecutionStatus to terminal status string for logger.
 *
 * Returns 'error' | 'stopped' - the EndGroupStatus values.
 * Using string literal return type to avoid circular import with messageTypes.
 *
 * Transformation rules:
 * - `completed` → `stopped` (green/neutral in UI)
 * - `interrupted` → `error` (red in UI)
 * - `error` → `error` (red in UI)
 *
 * UX note: User-initiated interruption shows as error (red) to make it visually
 * distinct from successful completion. This is intentional - interrupted runs
 * did not produce complete results, so a warning color is appropriate.
 */
export function executionToEndStatus(
  status: ExecutionStatus,
): 'error' | 'stopped' {
  return status === EXECUTION_STATUS.COMPLETED ? 'stopped' : 'error';
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
export const TERMINAL_STATUSES: readonly StreamStatus[] = [
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
 * Check if a status is terminal (execution ended).
 */
export function isTerminalStatus(status: StreamStatus | undefined): boolean {
  return status !== undefined && TERMINAL_STATUSES.includes(status);
}
