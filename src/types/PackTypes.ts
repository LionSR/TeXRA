export type PackStatus = 'success' | 'noFiles' | 'missingParams' | 'error';

export interface PackResult {
  /** Outcome of the pack operation */
  status: PackStatus;
  /** Output directory if files were packed */
  outputFolder?: string;
  /** Error message when status is 'error' */
  error?: string;
}
