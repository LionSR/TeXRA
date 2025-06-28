/**
 * Structured status for required files and figures used by agents.
 */

export interface RequiredFileStatus {
  /** File path */
  path: string;
  /** Variable name loaded from the file */
  varName: string;
  /** Whether the file was found */
  found: boolean;
}

export interface InputStatus {
  /** Required file statuses */
  required: RequiredFileStatus[];
  /** Figures successfully added */
  figures: { path: string }[];
}
