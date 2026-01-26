/**
 * Typed custom events for MainView components.
 * Follows the same pattern as ProgressView's events.ts.
 * Both dispatch and handler sides use these types.
 */

import type { FileType, MultipleFileType } from './constants';

// =============================================================================
// Event Detail Types
// =============================================================================

/** File select dropdown change */
export interface FileSelectChangeDetail {
  type: FileType;
  value: string;
}

/** Base file select change */
export interface BaseFileChangeDetail {
  value: string;
}

/** Edited file select change */
export interface EditedFileChangeDetail {
  value: string;
}

/** Single file action (refresh, current, empty) */
export interface FileActionDetail {
  type: FileType | 'base' | 'edited';
}

/** Multiple files action (toggle, select) */
export interface MultipleFilesActionDetail {
  listId: string;
}

/** Multiple files type action (add opened, empty) */
export interface MultipleFilesTypeActionDetail {
  type: FileType | MultipleFileType;
}

/** Remove file from list */
export interface RemoveFileDetail {
  listId: string;
  file: string;
}

/** Checkbox change */
export interface CheckboxChangeDetail {
  id: string;
  checked: boolean;
}

/** Banner action */
export interface BannerActionDetail {
  action: string;
  provider?: string;
  customDirSet?: boolean;
}

/** Install guide action */
export interface InstallGuideDetail {
  tool: string;
}

/** LaTeXDiffs visibility toggle */
export interface LatexDiffsToggleDetail {
  visible: boolean;
}

/** LaTeXDiffs action (diff, merge, compare, etc.) */
export interface LatexDiffsActionDetail {
  action:
    | 'latexdiff'
    | 'latexdiffvc'
    | 'packLatexdiffvc'
    | 'cleanLatexdiffvc'
    | 'merge'
    | 'compare'
    | 'accept';
}

/** Commit change */
export interface CommitChangeDetail {
  value: string;
}

/** Focus instruction detail */
export interface FocusInstructionDetail {
  key: string;
  text: string;
}

// =============================================================================
// Event Creators - use these to dispatch typed events
// =============================================================================

/** Create a bubbling composed custom event with typed detail. */
function createEvent<T>(type: string, detail: T): CustomEvent<T> {
  return new CustomEvent(type, { detail, bubbles: true, composed: true });
}

/**
 * MainView event creators.
 * Mirrors the ProgressEvents pattern for consistency.
 */
export const MainViewEvents = {
  // File select events
  fileChange: (detail: FileSelectChangeDetail) =>
    createEvent('file-change', detail),

  baseFileChange: (detail: BaseFileChangeDetail) =>
    createEvent('base-file-change', detail),

  editedFileChange: (detail: EditedFileChangeDetail) =>
    createEvent('edited-file-change', detail),

  refreshFiles: (detail: FileActionDetail) =>
    createEvent('refresh-files', detail),

  getCurrentFile: (detail: FileActionDetail) =>
    createEvent('get-current-file', detail),

  emptyFile: (detail: FileActionDetail) => createEvent('empty-file', detail),

  toggleList: (detail: MultipleFilesActionDetail) =>
    createEvent('toggle-list', detail),

  addOpenedFiles: (detail: MultipleFilesTypeActionDetail) =>
    createEvent('add-opened-files', detail),

  emptyFiles: (detail: MultipleFilesTypeActionDetail) =>
    createEvent('empty-files', detail),

  selectMultipleFiles: (detail: MultipleFilesActionDetail) =>
    createEvent('select-multiple-files', detail),

  removeFile: (detail: RemoveFileDetail) => createEvent('remove-file', detail),

  checkboxChange: (detail: CheckboxChangeDetail) =>
    createEvent('checkbox-change', detail),

  refreshEditedFiles: () => createEvent('refresh-edited-files', {}),

  commitChange: (detail: CommitChangeDetail) =>
    createEvent('commit-change', detail),

  refreshCommits: () => createEvent('refresh-commits', {}),

  focusInstruction: (detail: FocusInstructionDetail) =>
    createEvent('focus-instruction', detail),

  // Banner events
  apiKeyAction: (detail: BannerActionDetail) =>
    createEvent('api-key-action', detail),

  agentConfigAction: (detail: BannerActionDetail) =>
    createEvent('agent-config-action', detail),

  dependencyDismiss: () => createEvent('dependency-dismiss', {}),

  recheckDependencies: () => createEvent('recheck-dependencies', {}),

  openInstallGuide: (detail: InstallGuideDetail) =>
    createEvent('open-install-guide', detail),

  signIn: () => createEvent('sign-in', {}),

  dismissLogin: () => createEvent('dismiss-login', {}),

  // LaTeXDiffs events
  latexDiffsToggle: (detail: LatexDiffsToggleDetail) =>
    createEvent('latexdiffs-toggle', detail),

  latexDiffsAction: (detail: LatexDiffsActionDetail) =>
    createEvent('latexdiffs-action', detail),
} as const;
