/**
 * Diff statistic interfaces used for file comparisons.
 */

export interface DiffStats {
  /** Number of added lines */
  added?: number;
  /** Number of removed lines */
  removed?: number;
}

/**
 * Info about an output file including diff statistics and its related files.
 */
export interface OutputFileInfo extends DiffStats {
  /** Path to the generated output file */
  path: string;
  /** Base file used for comparison */
  base?: string | null;
  /** Previous round file for comparison */
  prev?: string | null;
  /** Original source file if different */
  original?: string | null;
}
