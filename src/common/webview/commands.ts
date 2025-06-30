/**
 * Standardized command constants for all webviews
 */

// Common commands used across all views
export const COMMON_COMMANDS = {
  THEME_SET: 'setTheme',
  DEBUG_MODE_SET: 'setDebugMode',
  STATE_RESTORE: 'restoreState',
  WEBVIEW_READY: 'webviewReady',
} as const;

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
  GET_THEME: 'getTheme',
  GET_DEBUG_MODE: 'getDebugMode',
  GET_CURRENT_FILE: 'getCurrentFile',
  ADD_OPENED_FILES: 'addOpenedFiles',
  POLISH_INSTRUCTION_TEXT: 'polishInstructionText',
  TRANSCRIBE_INSTRUCTION: 'transcribeInstruction',
  START_RECORDING: 'startRecording',
  STOP_RECORDING: 'stopRecording',
  SHOW_AGENT_HISTORY: 'showAgentHistory',
  OPEN_AGENT_SETTINGS: 'openAgentSettings',
  OPEN_MODEL_SETTINGS: 'openModelSettings',
  CLIPBOARD_IMAGE: 'clipboardImage',
} as const;

// Progress view specific commands  
export const PROGRESS_VIEW_COMMANDS = {
  ...COMMON_COMMANDS,
  // Stream management
  SWITCH_STREAM: 'switchStream',
  DELETE_STREAM: 'deleteStream',
  STOP_STREAM: 'stopStream',
  ERASE_STREAM: 'eraseStream',
  UPDATE_STREAMS: 'updateStreams',
  DELETE_ALL: 'deleteAll',
  
  // Logging
  UPDATE_LOGS: 'updateLogs',
  CLEAR_LOGS: 'clearLogs',
  APPEND_LOG: 'appendLog',
  UPDATE_LOG: 'updateLog',
  
  // Groups
  ADD_LOG_GROUP: 'addLogGroup',
  UPDATE_LOG_GROUP: 'updateLogGroup',
  
  // Status and files
  UPDATE_STATUS: 'updateStatus',
  UPDATE_FILES: 'updateFiles',
  
  // Usage
  UPDATE_USAGE: 'updateUsage',
  UPDATE_GROUP_USAGE: 'updateGroupUsage',
  
  // Actions
  RUN_AGAIN: 'runAgain',
  DIFF_STREAM: 'diffStream',
  PACK_STREAM: 'packStream',
  CLEAN_STREAM: 'cleanStream',
  RESTORE_STATE: 'restoreState',
  
  // File operations
  OPEN_FILE: 'openFile',
  COMPARE_ORIGINAL: 'compareOriginal',
  COMPARE_PREVIOUS: 'comparePrevious',
  ACCEPT_FILE: 'acceptFile',
  MERGE_FILE: 'mergeFile',
  LATEXDIFF_FILE: 'latexdiffFile',
} as const;

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
} as const;

// Export all commands in a single object for convenience
export const WEBVIEW_COMMANDS = {
  COMMON: COMMON_COMMANDS,
  MAIN_VIEW: MAIN_VIEW_COMMANDS,
  PROGRESS_VIEW: PROGRESS_VIEW_COMMANDS,
  HISTORY_VIEW: HISTORY_VIEW_COMMANDS,
} as const;

// Type definitions for better type safety
export type CommonCommand = typeof COMMON_COMMANDS[keyof typeof COMMON_COMMANDS];
export type MainViewCommand = typeof MAIN_VIEW_COMMANDS[keyof typeof MAIN_VIEW_COMMANDS];
export type ProgressViewCommand = typeof PROGRESS_VIEW_COMMANDS[keyof typeof PROGRESS_VIEW_COMMANDS];
export type HistoryViewCommand = typeof HISTORY_VIEW_COMMANDS[keyof typeof HISTORY_VIEW_COMMANDS];
export type WebviewCommand = CommonCommand | MainViewCommand | ProgressViewCommand | HistoryViewCommand;