/**
 * Standardized command constants for all webviews
 */

// Common commands used across all views
export const COMMON_COMMANDS = {
  THEME_SET: 'setTheme',
  DEBUG_MODE_SET: 'setDebugMode',
  STATE_RESTORE: 'restoreState',
  WEBVIEW_READY: 'webviewReady',
  ERROR: 'error',
};

// Main view specific commands
export const MAIN_VIEW_COMMANDS = {
  ...COMMON_COMMANDS,
  // File operations
  FILE_SELECT: 'selectFile',
  FILE_SELECTED: 'fileSelected',
  FILES_UPDATE: 'updateFiles',

  // Execution
  EXECUTE: 'execute',
  MERGE: 'merge',
  COMPARE: 'compare',

  // Settings
  MODEL_SELECTED: 'modelSelected',
  SETTINGS_OPEN: 'openSettings',

  // File selection cases
  SELECT_INPUT_FILE: 'selectInputFile',
  SELECT_REFERENCE_FILE: 'selectReferenceFile',
  SELECT_AUXILIARY_FILE: 'selectAuxiliaryFile',
  SELECT_MEDIA_FILE: 'selectMediaFile',
  SELECT_EDITED_FILE: 'selectEditedFile',

  // File selected cases
  INPUT_FILE_SELECTED: 'inputFileSelected',
  REFERENCE_FILE_SELECTED: 'referenceFileSelected',
  AUXILIARY_FILE_SELECTED: 'auxiliaryFileSelected',
  MEDIA_FILE_SELECTED: 'mediaFileSelected',
  EDITED_FILE_SELECTED: 'editedFileSelected',

  // Request file cases
  REQUEST_INPUT_FILE: 'requestInputFile',
  REQUEST_REFERENCE_FILE: 'requestReferenceFile',
  REQUEST_AUXILIARY_FILE: 'requestAuxiliaryFile',
  REQUEST_MEDIA_FILE: 'requestMediaFile',
  REQUEST_EDITED_FILE: 'requestEditedFile',
  REQUEST_BASE_FILE: 'requestBaseFile',
  REQUEST_DEFAULT_OUTPUT_FILES: 'requestDefaultOutputFiles',

  // Multiple file operations
  SET_INPUT_FILES: 'setInputFiles',
  SET_REFERENCE_FILES: 'setReferenceFiles',
  SET_AUXILIARY_FILES: 'setAuxiliaryFiles',
  SET_MEDIA_FILES: 'setMediaFiles',
  SELECT_MULTIPLE_FILES: 'selectMultipleFiles',

  // Other operations
  SHOW_INFORMATION_MESSAGE: 'showInformationMessage',
  SHOW_INSTRUCTION: 'showInstruction',
  GET_THEME: 'getTheme',
  GET_DEBUG_MODE: 'getDebugMode',
  GET_CURRENT_FILE: 'getCurrentFile',
  ADD_OPENED_FILES: 'addOpenedFiles',
  POLISH_INSTRUCTION_TEXT: 'polishInstructionText',
  TRANSCRIBE_INSTRUCTION: 'transcribeInstruction',
  START_RECORDING: 'startRecording',
  STOP_RECORDING: 'stopRecording',
  RECORDING_STOPPED: 'recordingStopped',
  SHOW_AGENT_HISTORY: 'showAgentHistory',
  OPEN_AGENT_SETTINGS: 'openAgentSettings',
  OPEN_MODEL_SETTINGS: 'openModelSettings',
  CLIPBOARD_IMAGE: 'clipboardImage',
  OPEN_SET_API_KEY: 'openSetApiKey',
  OPEN_SET_PROVIDER_API_KEY: 'openSetProviderApiKey',
  OPEN_PROVIDER_API_KEY_URL: 'openProviderApiKeyUrl',
  OPEN_API_KEY_GUIDE: 'openApiKeyGuide',
  SHOW_API_KEY_BANNER: 'showApiKeyBanner',
  HIDE_API_KEY_BANNER: 'hideApiKeyBanner',
  OPEN_AGENT_DIRECTORY: 'openAgentDirectory',
  OPEN_AGENT_DOCS: 'openAgentDocs',
  OPEN_INSTALLATION_DOCS: 'openInstallationDocs',
  OPEN_INSTALL_GUIDE: 'openInstallGuide',
  RECHECK_DEPENDENCIES: 'recheckDependencies',
  SHOW_AGENT_CONFIG_BANNER: 'showAgentConfigBanner',
  HIDE_AGENT_CONFIG_BANNER: 'hideAgentConfigBanner',
  SHOW_DEPENDENCY_BANNER: 'showDependencyBanner',
  HIDE_DEPENDENCY_BANNER: 'hideDependencyBanner',
  UPDATE_DEPENDENCY_REMINDER_SETTING: 'updateDependencyReminderSetting',
  SHOW_GETTING_STARTED_BANNER: 'showGettingStartedBanner',
  HIDE_GETTING_STARTED_BANNER: 'hideGettingStartedBanner',
  SHOW_LOGIN_BANNER: 'showLoginBanner',
  HIDE_LOGIN_BANNER: 'hideLoginBanner',
  SIGN_IN_FROM_BANNER: 'signInFromBanner',
  DISMISS_LOGIN_BANNER: 'dismissLoginBanner',

  // Extension response events
  CHECK_RESTORED_BASE_FILE: 'checkRestoredBaseFile',
  INSTRUCTION_TEXT_POLISHED: 'instructionTextPolished',
  INSTRUCTION_TEXT_POLISH_ERROR: 'instructionTextPolishError',
  INSTRUCTION_TEXT_TRANSCRIBED: 'instructionTextTranscribed',
  RECORDING_STARTED: 'recordingStarted',
  RECORDING_ERROR: 'recordingError',
  SET_INPUT_FILE: 'setInputFile',
  SET_REFERENCE_FILE: 'setReferenceFile',
  SET_AUXILIARY_FILE: 'setAuxiliaryFile',
  SET_MEDIA_FILE: 'setMediaFile',
  SET_EDITED_FILE: 'setEditedFile',
  SET_DEFAULT_OUTPUT_FILES: 'setDefaultOutputFiles',
  ADD_MEDIA_FILE: 'addMediaFile',
  SET_OUTPUT_FILES: 'setOutputFiles',
  SET_RECENT_COMMITS: 'setRecentCommits',
  SET_CURRENT_FILE: 'setCurrentFile',
  SET_OPENED_FILES: 'setOpenedFiles',
  SET_BASE_FILE: 'setBaseFile',
  SET_ALL_SINGLE_FILES: 'setAllSingleFiles',
  SET_SELECTED_COMMIT: 'setSelectedCommit',
  SET_MODEL_OPTIONS: 'setModelOptions',
  SET_AGENT_OPTIONS: 'setAgentOptions',
  SET_SELECTED_AGENT: 'setSelectedAgent',

  // File refresh and update operations
  REFRESH_ALL_FILES: 'refreshAllFiles',
  UPDATE_INPUT_FILES: 'updateInputFiles',
  UPDATE_REFERENCE_FILES: 'updateReferenceFiles',
  UPDATE_AUXILIARY_FILES: 'updateAuxiliaryFiles',
  UPDATE_MEDIA_FILES: 'updateMediaFiles',
  UPDATE_OUTPUT_FILES: 'updateOutputFiles',

  // Git/diff operations
  REQUEST_RECENT_COMMITS: 'requestRecentCommits',
  REFRESH_COMMITS: 'refreshCommits',
  LATEXDIFF: 'latexdiff',
  LATEXDIFFVC: 'latexdiffvc',
  PACK_LATEXDIFFVC: 'packLatexdiffvc',
  CLEAN_LATEXDIFFVC: 'cleanLatexdiffvc',

  // Housekeeping operations
  CLEAN_OUTPUT: 'cleanOutput',
  CLEAN_BUILD: 'cleanBuild',
  INDENT_TEX: 'indentTeX',
  PACK_SINGLE: 'packSingle',
  CLEAN_SINGLE: 'cleanSingle',
  PACK_MULTIPLE: 'packMultiple',
  CLEAN_MULTIPLE: 'cleanMultiple',

  // Other operations
  ACCEPT_EDITED: 'acceptEdited',
};

// Progress view specific commands
export const PROGRESS_VIEW_COMMANDS = {
  ...COMMON_COMMANDS,
  // Stream management
  SWITCH_STREAM: 'switchStream',
  DELETE_STREAM: 'deleteStream',
  ERASE_STREAM: 'eraseStream',
  CLEAN_STREAM: 'cleanStream',
  STOP_STREAM: 'stopStream',
  UPDATE_STREAMS: 'updateStreams',
  DELETE_ALL: 'deleteAll',

  // Logging
  UPDATE_LOGS: 'updateLogs',
  CLEAR_LOGS: 'clearLogs',
  APPEND_LOG: 'appendLog',
  UPDATE_LOG: 'updateLog',

  // Instruction panel
  UPDATE_INSTRUCTION: 'updateInstruction',

  // Task Groups
  ADD_TASK_GROUP: 'addTaskGroup',
  UPDATE_TASK_GROUP: 'updateTaskGroup',

  // Todo List
  UPDATE_TODOS: 'updateTodos',

  // Status and files
  UPDATE_STATUS: 'updateStatus',
  UPDATE_STREAM_STATUS: 'updateStreamStatus', // Update single stream's status in tabs
  UPDATE_FILES: 'updateFiles',
  UPDATE_MISSING_OUTPUTS: 'updateMissingOutputs',
  SHOW_TOOL_EDIT_APPROVAL: 'showToolEditApproval',
  RESOLVE_TOOL_EDIT_APPROVAL: 'resolveToolEditApproval',
  UPDATE_TOOL_EDIT_APPROVAL_STATE: 'updateToolEditApprovalState',
  SHOW_RETRY_REQUEST: 'showRetryRequest',
  RESOLVE_RETRY_REQUEST: 'resolveRetryRequest',

  // Usage
  UPDATE_USAGE: 'updateUsage',
  UPDATE_RUN_USAGE: 'updateRunUsage', // Update single run's usage (incremental)

  // Actions
  RUN_AGAIN: 'runAgain',
  RUN_NEW: 'runNew',
  RETRY_STREAM_REQUEST: 'retryStreamRequest',
  CANCEL_RETRY_REQUEST: 'cancelRetryRequest',
  DIFF_STREAM: 'diffStream',
  PACK_STREAM: 'packStream',
  SORT_STREAMS: 'sortStreams',
  FILTER_STREAMS: 'filterStreams',
  RESTORE_STATE: 'restoreState',
  SEND_FOLLOW_UP: 'sendFollowUp',
  POLISH_FOLLOW_UP: 'polishFollowUp',
  FOLLOW_UP_TEXT_POLISHED: 'followUpTextPolished',
  FOLLOW_UP_TEXT_TRANSCRIBED: 'followUpTextTranscribed',
  START_RECORDING: 'startRecording',
  STOP_RECORDING: 'stopRecording',
  RECORDING_STOPPED: 'recordingStopped',
  RECORDING_STARTED: 'recordingStarted',
  RECORDING_ERROR: 'recordingError',
  SHOW_INFORMATION_MESSAGE: 'showInformationMessage',
  OPEN_TASK_STORAGE: 'openTaskStorage',
  TOOL_EDIT_APPROVAL_ACTION: 'toolEditApprovalAction',
  RESET_TOOL_EDIT_APPROVAL_BYPASS: 'resetToolEditApprovalBypass',

  // File operations
  OPEN_FILE: 'openFile',
  OPEN_FILE_COMPILE: 'openFileCompile',
  COMPARE_ORIGINAL: 'compareOriginal',
  COMPARE_PREVIOUS: 'comparePrevious',
  ACCEPT_FILE: 'acceptFile',
  MERGE_FILE: 'mergeFile',
  LATEXDIFF_FILE: 'latexdiffFile',
  OPEN_LABEL: 'openLabel',

  // Profile
  OPEN_PROFILE: 'openProfile',
};

// History view specific commands
export const HISTORY_VIEW_COMMANDS = {
  ...COMMON_COMMANDS,
  GET_HISTORY_DATA: 'getHistoryData',
  UPDATE_HISTORY: 'updateHistory',
  CLEAR_HISTORY: 'clearHistory',
  HISTORY_CLEARED: 'historyCleared',
  RERUN_AGENT: 'rerunAgent',
  RESTORE_AGENT: 'restoreAgent',
  DELETE_AGENT: 'deleteAgent',
};

// Profile view specific commands
export const PROFILE_VIEW_COMMANDS = {
  ...COMMON_COMMANDS,
  GET_PROFILE_DATA: 'getProfileData',
  UPDATE_PROFILE: 'updateProfile',
  SELECT_AGENT: 'selectAgent',
  SIGN_IN: 'signIn',
  SIGN_OUT: 'signOut',
  // API access mode toggle (Ultra tier)
  SET_API_ACCESS_MODE: 'setApiAccessMode',
};

// Export all commands in a single object for convenience
export const WEBVIEW_COMMANDS = {
  COMMON: COMMON_COMMANDS,
  MAIN_VIEW: MAIN_VIEW_COMMANDS,
  PROGRESS_VIEW: PROGRESS_VIEW_COMMANDS,
  HISTORY_VIEW: HISTORY_VIEW_COMMANDS,
  PROFILE_VIEW: PROFILE_VIEW_COMMANDS,
};
