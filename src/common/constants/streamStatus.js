/**
 * Stream status constants shared across agent runtime and UI layers.
 *
 * These constants define the possible states of an agent execution stream.
 * This is the JavaScript version for webview ES modules.
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
};
