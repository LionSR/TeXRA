/**
 * Stream status constants shared across agent runtime and UI layers.
 *
 * These constants define the possible states of an agent execution stream.
 * Moved from progressView to common to break the layer violation where
 * agent runtime was importing from the presentation layer.
 */

export const STREAM_STATUS = {
  /** Agent is actively processing. */
  RUNNING: 'running',
  /** Agent encountered an error. */
  ERROR: 'error',
  /** Agent was stopped by user request. */
  STOPPED: 'stopped',
  /** Agent completed and is ready for new tasks. */
  READY: 'ready',
  /** Agent is waiting for user input or external resource. */
  WAITING: 'waiting',
  /** Agent is resuming from a previous session. */
  RESUMING: 'resuming',
} as const;

export type StreamStatus = (typeof STREAM_STATUS)[keyof typeof STREAM_STATUS];

/**
 * @deprecated Use STREAM_STATUS instead. This alias exists for backwards
 * compatibility during migration from progressView constants.
 */
export const STATUS = STREAM_STATUS;
