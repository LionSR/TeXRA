/**
 * Typed custom events for MainView components.
 * Follows the same pattern as ProgressView's events.ts.
 * Both dispatch and handler sides use these types.
 */

// Local imports - shared utilities
import type {
  ActionDetail,
  AgentChangeDetail,
  BaseFileChangeDetail,
  BannerActionDetail,
  CheckboxChangeDetail,
  CommitChangeDetail,
  EditedFileChangeDetail,
  FileActionDetail,
  FocusInstructionDetail,
  InstallGuideDetail,
  InstructionChangeDetail,
  LatexDiffsActionDetail,
  LatexDiffsToggleDetail,
  ModelChangeDetail,
  MultipleFilesActionDetail,
  MultipleFilesTypeActionDetail,
  ReorderFilesDetail,
  RemoveFileDetail,
  SessionTypeChangeDetail,
} from '@shared/schemas';
import { createEvent } from '@shared/utils/events';
export const MainViewEvents = {
  // File select events
  baseFileChange: (detail: BaseFileChangeDetail) =>
    createEvent('base-file-change', detail),

  editedFileChange: (detail: EditedFileChangeDetail) =>
    createEvent('edited-file-change', detail),

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

  filesReordered: (detail: ReorderFilesDetail) =>
    createEvent('files-reordered', detail),

  checkboxChange: (detail: CheckboxChangeDetail) =>
    createEvent('checkbox-change', detail),

  refreshEditedFiles: () => createEvent('refresh-edited-files', undefined),

  commitChange: (detail: CommitChangeDetail) =>
    createEvent('commit-change', detail),

  refreshCommits: () => createEvent('refresh-commits', undefined),

  focusInstruction: (detail: FocusInstructionDetail) =>
    createEvent('focus-instruction', detail),

  // Banner events
  apiKeyAction: (detail: BannerActionDetail) =>
    createEvent('api-key-action', detail),

  agentConfigAction: (detail: BannerActionDetail) =>
    createEvent('agent-config-action', detail),

  dependencyDismiss: () => createEvent('dependency-dismiss', undefined),

  recheckDependencies: () => createEvent('recheck-dependencies', undefined),

  openInstallGuide: (detail: InstallGuideDetail) =>
    createEvent('open-install-guide', detail),

  signIn: () => createEvent('sign-in', undefined),

  dismissLogin: () => createEvent('dismiss-login', undefined),

  dismissGettingStarted: () =>
    createEvent('dismiss-getting-started', undefined),

  dismissSessionHint: () => createEvent('dismiss-session-hint', undefined),

  // LaTeXDiffs events
  latexDiffsToggle: (detail: LatexDiffsToggleDetail) =>
    createEvent('latexdiffs-toggle', detail),

  latexDiffsAction: (detail: LatexDiffsActionDetail) =>
    createEvent('latexdiffs-action', detail),

  // InstructionPanel events
  sessionTypeChange: (detail: SessionTypeChangeDetail) =>
    createEvent('session-type-change', detail),

  agentChange: (detail: AgentChangeDetail) =>
    createEvent('agent-change', detail),

  modelChange: (detail: ModelChangeDetail) =>
    createEvent('model-change', detail),

  instructionInput: (detail: InstructionChangeDetail) =>
    createEvent('instruction-input', detail),

  panelAction: (detail: ActionDetail) => createEvent('panel-action', detail),

  execute: () => createEvent('execute', undefined),

  agentSettings: () => createEvent('agent-settings', undefined),

  modelSettings: () => createEvent('model-settings', undefined),

  instructionPaste: () => createEvent('instruction-paste', undefined),
} as const;
