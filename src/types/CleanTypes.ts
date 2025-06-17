export type CleanStatus = 'success' | 'noFiles' | 'missingParams' | 'error';

export interface CleanResult {
  /** Outcome of the clean operation */
  status: CleanStatus;
  /** Error message when status is 'error' */
  error?: string;
}
