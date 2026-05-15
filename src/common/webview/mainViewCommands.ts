/**
 * Command constants for the main view.
 */
import { COMMON_COMMANDS } from './commonCommands';

// Main view specific commands
export const MAIN_VIEW_COMMANDS = {
  ...COMMON_COMMANDS,

  // Execution
  EXECUTE: 'execute',
  MERGE: 'merge',
  COMPARE: 'compare',

  // Settings
  MODEL_SELECTED: 'modelSelected',
  SETTINGS_OPEN: 'openSettings',

  // File selection cases
  SELECT_INPUT_FILE: 'selectInputFile',
  SELECT_CONTEXT_FILE: 'selectContextFile',
  SELECT_MEDIA_FILE: 'selectMediaFile',
  SELECT_EDITED_FILE: 'selectEditedFile',

  // File selected cases
  INPUT_FILE_SELECTED: 'inputFileSelected',
  CONTEXT_FILE_SELECTED: 'contextFileSelected',
  MEDIA_FILE_SELECTED: 'mediaFileSelected',
  EDITED_FILE_SELECTED: 'editedFileSelected',

  // Request file cases
  REQUEST_INPUT_FILE: 'requestInputFile',
  REQUEST_CONTEXT_FILE: 'requestContextFile',
  REQUEST_MEDIA_FILE: 'requestMediaFile',
  REQUEST_EDITED_FILE: 'requestEditedFile',
  REQUEST_BASE_FILE: 'requestBaseFile',
  REQUEST_DEFAULT_OUTPUT_FILES: 'requestDefaultOutputFiles',

  // Multiple file operations
  SET_INPUT_FILES: 'setInputFiles',
  SET_CONTEXT_FILES: 'setContextFiles',
  SET_MEDIA_FILES: 'setMediaFiles',
  SELECT_MULTIPLE_FILES: 'selectMultipleFiles',

  // Other operations
  SHOW_INFORMATION_MESSAGE: 'showInformationMessage',
  SHOW_INSTRUCTION: 'showInstruction',
  GET_THEME: 'getTheme',
  GET_DEBUG_MODE: 'getDebugMode',
  GET_CURRENT_FILE: 'getCurrentFile',
  ADD_OPENED_FILES: 'addOpenedFiles',
  ATTACH_DROPPED_FILES: 'attachDroppedFiles',
  POLISH_INSTRUCTION_TEXT: 'polishInstructionText',
  TRANSCRIBE_INSTRUCTION: 'transcribeInstruction',
  START_RECORDING: 'startRecording',
  STOP_RECORDING: 'stopRecording',
  RECORDING_STOPPED: 'recordingStopped',
  SHOW_AGENT_HISTORY: 'showAgentHistory',
  OPEN_AGENT_SETTINGS: 'openAgentSettings',
  OPEN_MODEL_SETTINGS: 'openModelSettings',
  OPEN_MULTI_AGENT_SETTINGS: 'openMultiAgentSettings',
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
  SHOW_GETTING_STARTED_BANNER: 'showGettingStartedBanner',
  HIDE_GETTING_STARTED_BANNER: 'hideGettingStartedBanner',
  SHOW_LOGIN_BANNER: 'showLoginBanner',
  HIDE_LOGIN_BANNER: 'hideLoginBanner',
  SIGN_IN_FROM_BANNER: 'signInFromBanner',
  DISMISS_LOGIN_BANNER: 'dismissLoginBanner',
  DISMISS_GETTING_STARTED_BANNER: 'dismissGettingStartedBanner',
  DISMISS_ORCHESTRATOR_BANNER: 'dismissOrchestratorBanner',
  SHOW_ORCHESTRATOR_BANNER: 'showOrchestratorBanner',
  HIDE_ORCHESTRATOR_BANNER: 'hideOrchestratorBanner',

  // Extension response events
  INSTRUCTION_TEXT_POLISHED: 'instructionTextPolished',
  INSTRUCTION_TEXT_POLISH_ERROR: 'instructionTextPolishError',
  INSTRUCTION_TEXT_TRANSCRIBED: 'instructionTextTranscribed',
  RECORDING_STARTED: 'recordingStarted',
  RECORDING_ERROR: 'recordingError',
  SET_INPUT_FILE: 'setInputFile',
  SET_CONTEXT_FILE: 'setContextFile',
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
  UPDATE_CONTEXT_FILES: 'updateContextFiles',
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
} as const;
