/**
 * Typed custom events for MainView components.
 * Follows the same pattern as ProgressView's events.ts.
 * Both dispatch and handler sides use these types.
 */

// Local imports - shared utilities
import type {
  AgentConfigBannerActionDetail,
  ApiKeyBannerActionDetail,
  BaseFileChangeDetail,
  CheckboxChangeDetail,
  CommitChangeDetail,
  EditedFileChangeDetail,
  FileActionDetail,
  GettingStartedActionDetail,
  InstallGuideDetail,
  LatexDiffsActionDetail,
  MultipleFilesActionDetail,
  MultipleFilesTypeActionDetail,
  ReorderFilesDetail,
  RemoveFileDetail,
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

  // Banner events
  apiKeyAction: (detail: ApiKeyBannerActionDetail) =>
    createEvent('api-key-action', detail),

  agentConfigAction: (detail: AgentConfigBannerActionDetail) =>
    createEvent('agent-config-action', detail),

  dependencyDismiss: () => createEvent('dependency-dismiss', undefined),

  recheckDependencies: () => createEvent('recheck-dependencies', undefined),

  openInstallGuide: (detail: InstallGuideDetail) =>
    createEvent('open-install-guide', detail),

  signIn: () => createEvent('sign-in', undefined),

  dismissLogin: () => createEvent('dismiss-login', undefined),

  // Onboarding welcome card events (State 0 of the onboarding funnel)
  welcomeChatGpt: () => createEvent('welcome-chatgpt', undefined),

  welcomeApiKey: () => createEvent('welcome-api-key', undefined),

  welcomeSkip: () => createEvent('welcome-skip', undefined),

  onboardingRunSetup: () => createEvent('onboarding-run-setup', undefined),

  onboardingOpenGettingStarted: () =>
    createEvent('onboarding-open-getting-started', undefined),

  onboardingSkipSetup: () => createEvent('onboarding-skip-setup', undefined),

  dismissGettingStarted: () =>
    createEvent('dismiss-getting-started', undefined),

  gettingStartedAction: (detail: GettingStartedActionDetail) =>
    createEvent('getting-started-action', detail),

  // LaTeXDiffs events
  latexDiffsAction: (detail: LatexDiffsActionDetail) =>
    createEvent('latexdiffs-action', detail),
} as const;
