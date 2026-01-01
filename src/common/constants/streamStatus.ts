/**
 * Stream status constants shared across agent runtime and UI layers.
 */
import { z } from 'zod';

export const STREAM_STATUS = {
  RUNNING: 'running',
  ERROR: 'error',
  STOPPED: 'stopped',
  READY: 'ready',
  WAITING: 'waiting',
  RESUMING: 'resuming',
} as const;

export const StreamStatusSchema = z.enum([
  STREAM_STATUS.RUNNING,
  STREAM_STATUS.ERROR,
  STREAM_STATUS.STOPPED,
  STREAM_STATUS.READY,
  STREAM_STATUS.WAITING,
  STREAM_STATUS.RESUMING,
]);

export type StreamStatus = z.infer<typeof StreamStatusSchema>;

/**
 * Task group status - subset of StreamStatus used for task groups.
 * Single source of truth for TaskGroup.status in LogTypes.ts and eventBus/schemas.ts.
 */
export const TaskGroupStatusSchema = z.enum([
  STREAM_STATUS.RUNNING,
  STREAM_STATUS.ERROR,
  STREAM_STATUS.STOPPED,
  STREAM_STATUS.READY,
]);

export type TaskGroupStatus = z.infer<typeof TaskGroupStatusSchema>;

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
export const EXECUTION_STATUS = {
  COMPLETED: 'completed',
  INTERRUPTED: 'interrupted',
  ERROR: 'error',
} as const;

export const ExecutionStatusSchema = z.enum([
  EXECUTION_STATUS.COMPLETED,
  EXECUTION_STATUS.INTERRUPTED,
  EXECUTION_STATUS.ERROR,
]);

export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;

// ============================================================================
// Status Transformation Functions
// ============================================================================

/**
 * Convert ExecutionStatus to StreamStatus for UI display.
 *
 * Transformation rules:
 * - `completed` → `stopped` (green, task finished normally)
 * - `interrupted` → `error` (red, user/system stopped before completion)
 * - `error` → `error` (red, task failed with error)
 *
 * Note: `interrupted` maps to `error` because UI should show red status
 * when agent didn't complete its intended work, regardless of cause.
 */
export function executionToStreamStatus(status: ExecutionStatus): StreamStatus {
  switch (status) {
    case EXECUTION_STATUS.COMPLETED:
      return STREAM_STATUS.STOPPED;
    case EXECUTION_STATUS.INTERRUPTED:
      return STREAM_STATUS.ERROR;
    case EXECUTION_STATUS.ERROR:
      return STREAM_STATUS.ERROR;
  }
}

/**
 * Convert ExecutionStatus to terminal status string for logger.
 *
 * Returns 'error' | 'stopped' - the EndGroupStatus values.
 * Using string literal return type to avoid circular import with messageTypes.
 *
 * Transformation rules:
 * - `completed` → `stopped`
 * - `interrupted` → `error` (shows red in UI)
 * - `error` → `error`
 */
export function executionToEndStatus(
  status: ExecutionStatus,
): 'error' | 'stopped' {
  switch (status) {
    case EXECUTION_STATUS.COMPLETED:
      return 'stopped';
    case EXECUTION_STATUS.INTERRUPTED:
      return 'error';
    case EXECUTION_STATUS.ERROR:
      return 'error';
  }
}
