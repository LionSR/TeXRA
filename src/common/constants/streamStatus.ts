// Third-party imports
import { z } from 'zod';

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

/**
 * Schema for stream status validation.
 * Ensures only valid status values are accepted.
 */
export const StreamStatusSchema = z.enum([
  STREAM_STATUS.RUNNING,
  STREAM_STATUS.ERROR,
  STREAM_STATUS.STOPPED,
  STREAM_STATUS.READY,
  STREAM_STATUS.WAITING,
  STREAM_STATUS.RESUMING,
]);

/**
 * All possible stream states.
 * Derived from STREAM_STATUS constant to maintain single source of truth.
 */
export type StreamStatus = z.infer<typeof StreamStatusSchema>;
