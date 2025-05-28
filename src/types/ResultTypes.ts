/**
 * Common result interfaces used across utilities.
 */

export interface ExecResult {
  /** Indicates whether the command succeeded */
  success: boolean;
  /** Standard output from the command, if available */
  stdout: string | null;
  /** Standard error from the command, if available */
  stderr: string | null;
  /** True if the command timed out */
  timedOut?: boolean;
}
