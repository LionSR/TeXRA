/**
 * Typed custom events for MainView components.
 * Follows the same pattern as ProgressView's events.ts.
 * Both dispatch and handler sides use these types.
 */

// Local imports - shared schemas
import type {
  BannerActionDetail,
  BaseFileChangeDetail,
  CheckboxChangeDetail,
  CommitChangeDetail,
  EditedFileChangeDetail,
  FileActionDetail,
  FileSelectChangeDetail,
  FocusInstructionDetail,
  InstallGuideDetail,
  LatexDiffsActionDetail,
  LatexDiffsToggleDetail,
  MultipleFilesActionDetail,
  MultipleFilesTypeActionDetail,
  RemoveFileDetail,
} from '@shared/schemas';

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
