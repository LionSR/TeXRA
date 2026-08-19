/** Webview IPC command-name constants, grouped per view. */

export const COMMON_COMMANDS = {
  THEME_SET: 'setTheme',
  DEBUG_MODE_SET: 'setDebugMode',
  STATE_RESTORE: 'restoreState',
  WEBVIEW_READY: 'webviewReady',
  SWITCH_VIEW: 'switchView',
} as const;

export const MAIN_VIEW_COMMANDS = {
  ...COMMON_COMMANDS,

  // Execution
  EXECUTE: 'execute',
  MERGE: 'merge',
  COMPARE: 'compare',

  // Request file cases (single-file refresh requests)
  REQUEST_EDITED_FILE: 'requestEditedFile',
  REQUEST_BASE_FILE: 'requestBaseFile',

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
  START_RECORDING: 'startRecording',
  STOP_RECORDING: 'stopRecording',
  RECORDING_STOPPED: 'recordingStopped',
  OPEN_AGENT_SETTINGS: 'openAgentSettings',
  OPEN_MODEL_SETTINGS: 'openModelSettings',
  OPEN_MULTI_AGENT_SETTINGS: 'openMultiAgentSettings',
  CLIPBOARD_IMAGE: 'clipboardImage',
  OPEN_SET_API_KEY: 'openSetApiKey',
  OPEN_SET_PROVIDER_API_KEY: 'openSetProviderApiKey',
  OPEN_PROVIDER_API_KEY_URL: 'openProviderApiKeyUrl',
  OPEN_API_KEY_GUIDE: 'openApiKeyGuide',
  OPEN_AGENT_DIRECTORY: 'openAgentDirectory',
  OPEN_AGENT_DOCS: 'openAgentDocs',
  OPEN_INSTALL_GUIDE: 'openInstallGuide',
  RECHECK_DEPENDENCIES: 'recheckDependencies',
  /** One show/hide message for every main-view banner surface. */
  SET_BANNER: 'setBanner',
  GETTING_STARTED_ACTION: 'gettingStartedAction',
  SIGN_IN_FROM_BANNER: 'signInFromBanner',
  DISMISS_LOGIN_BANNER: 'dismissLoginBanner',
  DISMISS_ORCHESTRATOR_BANNER: 'dismissOrchestratorBanner',

  // Onboarding funnel (PRD: agent-native onboarding)
  ONBOARDING_SIGN_IN_CHATGPT: 'onboardingSignInChatGpt',
  ONBOARDING_RUN_SETUP: 'onboardingRunSetup',
  ONBOARDING_OPEN_GETTING_STARTED: 'onboardingOpenGettingStarted',
  ONBOARDING_SKIP: 'onboardingSkip',
  ONBOARDING_SKIP_SETUP: 'onboardingSkipSetup',
  SET_ONBOARDING_FUNNEL: 'setOnboardingFunnel',

  // Extension response events
  INSTRUCTION_TEXT_POLISHED: 'instructionTextPolished',
  INSTRUCTION_TEXT_POLISH_ERROR: 'instructionTextPolishError',
  INSTRUCTION_TEXT_TRANSCRIBED: 'instructionTextTranscribed',
  RECORDING_STARTED: 'recordingStarted',
  RECORDING_ERROR: 'recordingError',
  SET_EDITED_FILE: 'setEditedFile',
  ADD_MEDIA_FILE: 'addMediaFile',
  SET_OUTPUT_FILES: 'setOutputFiles',
  SET_RECENT_COMMITS: 'setRecentCommits',
  SET_CURRENT_FILE: 'setCurrentFile',
  SET_OPENED_FILES: 'setOpenedFiles',
  SET_BASE_FILE: 'setBaseFile',
  SET_SELECTED_COMMIT: 'setSelectedCommit',
  SET_MODEL_OPTIONS: 'setModelOptions',
  SET_AGENT_OPTIONS: 'setAgentOptions',
  SET_TEAM_OPTIONS: 'setTeamOptions',
  SET_WORKSPACE_ROOTS: 'setWorkspaceRoots',
  SET_SELECTED_AGENT: 'setSelectedAgent',

  // File refresh and update operations
  REFRESH_ALL_FILES: 'refreshAllFiles',

  // Git/diff operations
  REQUEST_RECENT_COMMITS: 'requestRecentCommits',
  REFRESH_COMMITS: 'refreshCommits',
  LATEXDIFF: 'latexdiff',
  LATEXDIFFVC: 'latexdiffvc',
  PACK_LATEXDIFFVC: 'packLatexdiffvc',
  CLEAN_LATEXDIFFVC: 'cleanLatexdiffvc',

  // Housekeeping operations
  PACK_SINGLE: 'packSingle',
  CLEAN_SINGLE: 'cleanSingle',
  PACK_MULTIPLE: 'packMultiple',
  CLEAN_MULTIPLE: 'cleanMultiple',

  ACCEPT_EDITED: 'acceptEdited',
} as const;

export const PROGRESS_VIEW_COMMANDS = {
  ...COMMON_COMMANDS,

  SWITCH_STREAM: 'switchStream',
  DELETE_STREAM: 'deleteStream',
  CLEAN_STREAM: 'cleanStream',
  STOP_STREAM: 'stopStream',
  UPDATE_STREAMS: 'updateStreams',
  UPDATE_STREAM_METADATA: 'updateStreamMetadata',
  DELETE_ALL: 'deleteAll',

  LOG_DELTA: 'logDelta',

  UPDATE_TODOS: 'updateTodos',
  UPDATE_PLAN: 'updatePlan',
  UPDATE_QUEUED_FOLLOW_UPS: 'updateQueuedFollowUps',
  SYNC_STREAM_CONTENT: 'syncStreamContent',

  UPDATE_STREAM_STATUS: 'updateStreamStatus',
  SET_ACTIVE_STREAM: 'setActiveStream',
  SETTLE_STREAM_SELECTION: 'settleStreamSelection',
  RELEASE_STREAM_CONTENT: 'releaseStreamContent',
  UPDATE_CONVERSATION_PROGRESS: 'updateConversationProgress',
  SYNC_INQUIRY_THREADS: 'syncInquiryThreads',
  UPDATE_INQUIRY_THREAD: 'updateInquiryThread',
  UPDATE_FILES: 'updateFiles',
  UPDATE_MISSING_OUTPUTS: 'updateMissingOutputs',
  UPDATE_COMPILE_FAILURES: 'updateCompileFailures',
  UPDATE_PERMISSION: 'updatePermission',
  UPDATE_BYPASS: 'updateBypass',

  UPDATE_RUN_USAGE: 'updateRunUsage',

  RESUME: 'resume',
  RUN_NEW: 'runNew',
  COMPACT_RESPONSE: 'compactResponse',
  RETRY_STREAM_REQUEST: 'retryStreamRequest',
  CANCEL_RETRY_REQUEST: 'cancelRetryRequest',
  USE_OWN_API_KEY: 'useOwnApiKey',
  DIFF_STREAM: 'diffStream',
  PACK_STREAM: 'packStream',
  RESTORE_STATE: 'restoreState',
  EXPORT_TRANSCRIPT: 'exportTranscript',
  SEND_FOLLOW_UP: 'sendFollowUp',
  POLISH_FOLLOW_UP: 'polishFollowUp',
  UPDATE_FOLLOW_UP_TEXT: 'updateFollowUpText',
  START_RECORDING: 'startRecording',
  STOP_RECORDING: 'stopRecording',
  UPDATE_RECORDING: 'updateRecording',
  OPEN_TASK_STORAGE: 'openTaskStorage',
  RUN_COMPILE_FIXER: 'runCompileFixer',
  TOOL_EDIT_APPROVAL_ACTION: 'toolEditApprovalAction',
  TOGGLE_TOOL_EDIT_APPROVAL_BYPASS: 'toggleToolEditApprovalBypass',
  ENABLE_APPROVAL_BYPASS: 'enableApprovalBypass',
  AGENT_PROPOSAL_ACTION: 'agentProposalAction',
  BASH_APPROVAL_ACTION: 'bashApprovalAction',
  PLAN_APPROVAL_ACTION: 'planApprovalAction',
  EXTERNAL_INQUIRY_ACTION: 'externalInquiryAction',
  USER_QUESTION_ACTION: 'userQuestionAction',
  RESTORE_PROPOSAL_CONFIG: 'restoreProposalConfig',
  TOGGLE_SUPER_YOLO_BYPASS: 'toggleSuperYoloBypass',
  ENABLE_SUPER_YOLO_BYPASS: 'enableSuperYoloBypass',
  GOAL_ACTIVE_UPDATED: 'goalActiveUpdated',

  OPEN_FILE: 'openFile',
  OPEN_SPILL_ARTIFACT: 'openSpillArtifact',
  COMPARE_ORIGINAL: 'compareOriginal',
  COMPARE_PREVIOUS: 'comparePrevious',
  ACCEPT_FILE: 'acceptFile',
  MERGE_FILE: 'mergeFile',
  LATEXDIFF_FILE: 'latexdiffFile',
  OPEN_LABEL: 'openLabel',

  GETTING_STARTED_ACTION: 'progressGettingStartedAction',

  POP_OUT: 'popOut',
  POP_BACK: 'popBack',
  SET_PLACEMENT: 'setPlacement',
} as const;

export const PROFILE_VIEW_COMMANDS = {
  ...COMMON_COMMANDS,
  UPDATE_PROFILE: 'updateProfile',
  SIGN_IN: 'signIn',
  SIGN_OUT: 'signOut',
} as const;

export const MEMORY_VIEW_COMMANDS = {
  ...COMMON_COMMANDS,
  GET_MEMORY_DATA: 'getMemoryData',
  GET_MEMORY_PREVIEW: 'getMemoryPreview',
  UPDATE_MEMORY: 'updateMemory',
  UPDATE_MEMORY_PREVIEW: 'updateMemoryPreview',
  OPEN_MEMORY_FILE: 'openMemoryFile',
  OPEN_MEMORY_FOLDER: 'openMemoryFolder',
  DELETE_MEMORY: 'deleteMemory',
  SET_MEMORY_ENABLED: 'setMemoryEnabled',
  UPDATE_MEMORY_ENABLED: 'updateMemoryEnabled',
  PIN_MEMORY: 'pinMemory',
  UNPIN_MEMORY: 'unpinMemory',
} as const;

/**
 * Command string literals for settings view schema definitions.
 * Defined here (not in settingsViewMessages.ts) to avoid the cycle
 * `ipc.ts → settingsViewMessages.ts → memoryViewMessages.ts → ipc.ts`.
 *
 * Memory and Profile inbound commands reference their own view's
 * command map (the single source of truth for those literals) instead of
 * repeating the string values, so the two can't drift.
 */
export const SETTINGS_VIEW_CMD = {
  // Navigation commands
  SET_TAB: 'setTab',
  // Memory commands
  GET_MEMORY_DATA: MEMORY_VIEW_COMMANDS.GET_MEMORY_DATA,
  GET_MEMORY_PREVIEW: MEMORY_VIEW_COMMANDS.GET_MEMORY_PREVIEW,
  OPEN_MEMORY_FILE: MEMORY_VIEW_COMMANDS.OPEN_MEMORY_FILE,
  OPEN_MEMORY_FOLDER: MEMORY_VIEW_COMMANDS.OPEN_MEMORY_FOLDER,
  DELETE_MEMORY: MEMORY_VIEW_COMMANDS.DELETE_MEMORY,
  SET_MEMORY_ENABLED: MEMORY_VIEW_COMMANDS.SET_MEMORY_ENABLED,
  PIN_MEMORY: MEMORY_VIEW_COMMANDS.PIN_MEMORY,
  UNPIN_MEMORY: MEMORY_VIEW_COMMANDS.UNPIN_MEMORY,
  // Profile commands
  SIGN_IN: PROFILE_VIEW_COMMANDS.SIGN_IN,
  SIGN_OUT: PROFILE_VIEW_COMMANDS.SIGN_OUT,
  SET_PROVIDER_KEY: 'setProviderKey',
  REMOVE_PROVIDER_KEY: 'removeProviderKey',
  OPEN_PROVIDER_KEY_URL: 'openProviderKeyUrl',
  OPEN_EXTERNAL_URL: 'openExternalUrl',
  // Model selection commands
  SET_MODEL_ENABLED: 'setModelEnabled',
  SET_MODEL_REASONING_LEVEL: 'setModelReasoningLevel',
  REQUEST_MODEL_ACCESS: 'requestModelAccess',
  CLEAR_COPILOT_ROUTE: 'clearCopilotRoute',
  // Agent selection commands
  OPEN_AGENT_YAML: 'openAgentYaml',
  SET_AGENT_ENABLED: 'setAgentEnabled',
  SET_ALL_AGENTS_ENABLED: 'setAllAgentsEnabled',
  OPEN_AGENT_FOLDER: 'openAgentFolder',
  CREATE_AGENT: 'createAgent',
  CUSTOMIZE_AGENT: 'customizeAgent',
  DELETE_CUSTOM_AGENT: 'deleteCustomAgent',
  REVEAL_AGENT_FILE: 'revealAgentFile',
  VIEW_REMOTE_AGENT_PROMPT: 'viewRemoteAgentPrompt',
  // Custom agent directory commands
  SET_CUSTOM_AGENT_DIR: 'setCustomAgentDir',
  RESET_CUSTOM_AGENT_DIR: 'resetCustomAgentDir',
  // Multi-Agent commands
  APPLY_AGENT_MODE_PRESET: 'applyAgentModePreset',
  SAVE_AGENT_MODE_PRESET: 'saveAgentModePreset',
  DELETE_AGENT_MODE_PRESET: 'deleteAgentModePreset',
  // Generic settings-view scalar write. The backend looks up {key, value} in the
  // unified catalog, validates and persists it using the row's metadata, then
  // refreshes the row's owning snapshot.
  UPDATE_STATE_SETTING: 'updateStateSetting',
  // Tool dashboard commands
  OPEN_TOOL_INSTALL_URL: 'openToolInstallUrl',
  INSTALL_TOOL_EXTENSION: 'installToolExtension',
  RECHECK_TOOL_STATUS: 'recheckToolStatus',
  TOGGLE_TOOL: 'toggleTool',
  RUN_TOOL_COMMAND: 'runToolCommand',
  // GitHub token commands (for PR subscription tool)
  GET_GITHUB_TOKEN_STATUS: 'getGitHubTokenStatus',
  UPDATE_GITHUB_TOKEN_STATUS: 'updateGitHubTokenStatus',
  SET_GITHUB_TOKEN: 'setGitHubToken',
  REMOVE_GITHUB_TOKEN: 'removeGitHubToken',
  OPEN_GITHUB_TOKEN_URL: 'openGitHubTokenUrl',
  // ChatGPT subscription (Codex) sign-in commands
  UPDATE_CHATGPT_AUTH_STATUS: 'updateChatGptAuthStatus',
  SIGN_IN_CHATGPT: 'signInChatGpt',
  SIGN_OUT_CHATGPT: 'signOutChatGpt',
  SET_CHATGPT_PREFER_SUBSCRIPTION: 'setChatGptPreferSubscription',
  // Grok (xAI SuperGrok) subscription sign-in commands
  UPDATE_GROK_AUTH_STATUS: 'updateGrokAuthStatus',
  SIGN_IN_GROK: 'signInGrok',
  SIGN_OUT_GROK: 'signOutGrok',
  SET_GROK_PREFER_SUBSCRIPTION: 'setGrokPreferSubscription',
  GET_SUBSCRIPTION_USAGE: 'getSubscriptionUsage',
  GET_PR_SUBSCRIPTIONS: 'getPRSubscriptions',
  UPDATE_PR_SUBSCRIPTIONS: 'updatePRSubscriptions',
  UNSUBSCRIBE_PR: 'unsubscribePR',
  OPEN_PR_SUBSCRIPTION_STREAM: 'openPRSubscriptionStream',
  // LaTeX settings commands
  APPLY_LATEX_SETTINGS: 'applyLatexSettings',
  INSTALL_LATEX_WORKSHOP: 'installLatexWorkshop',
  RUN_INSTALL_COMMAND: 'runInstallCommand',
  // Experimental settings
  GET_INLINE_CRITICISM_ENABLED: 'getInlineCriticismEnabled',
  SET_INLINE_CRITICISM_ENABLED: 'setInlineCriticismEnabled',
  GET_GOAL_LIST: 'getGoalList',
  REVEAL_GOAL_STREAM: 'revealGoalStream',
} as const;

// Settings view specific commands (combines Memory and Profile views)
// SETTINGS_VIEW_CMD is the source of truth; outbound-only commands are added here
export const SETTINGS_VIEW_COMMANDS = {
  ...COMMON_COMMANDS,
  ...SETTINGS_VIEW_CMD,
  // Outbound-only commands (backend → frontend, not schema-validated)
  UPDATE_MEMORY: MEMORY_VIEW_COMMANDS.UPDATE_MEMORY,
  UPDATE_MEMORY_PREVIEW: MEMORY_VIEW_COMMANDS.UPDATE_MEMORY_PREVIEW,
  UPDATE_MEMORY_ENABLED: MEMORY_VIEW_COMMANDS.UPDATE_MEMORY_ENABLED,
  UPDATE_PROFILE: PROFILE_VIEW_COMMANDS.UPDATE_PROFILE,
  UPDATE_MODEL_SELECTION: 'updateModelSelection',
  UPDATE_AGENT_SELECTION: 'updateAgentSelection',
  UPDATE_CUSTOM_AGENT_DIR: 'updateCustomAgentDir',
  UPDATE_SUPER_YOLO_ENABLED: 'updateSuperYoloEnabled',
  UPDATE_AGENT_MODE_PRESETS: 'updateAgentModePresets',
  // Stable outbound name for the broader execution-permissions-and-safety
  // snapshot (bash approval, coding-agent controls, and tool path protection).
  UPDATE_APPROVAL_SETTINGS: 'updateApprovalSettings',
  UPDATE_AGENT_SKILLS_SETTINGS: 'updateAgentSkillsSettings',
  UPDATE_TELEMETRY_SETTINGS: 'updateTelemetrySettings',
  UPDATE_TOOL_DASHBOARD: 'updateToolDashboard',
  UPDATE_GIT_AUTHOR_SETTINGS: 'updateGitAuthorSettings',
  UPDATE_SUBSCRIPTION_USAGE: 'updateSubscriptionUsage',
  UPDATE_LATEX_SETTINGS_STATUS: 'updateLatexSettingsStatus',
  UPDATE_LATEX_CONFIG_VALUES: 'updateLatexConfigValues',
  UPDATE_INLINE_CRITICISM_ENABLED: 'updateInlineCriticismEnabled',
  UPDATE_GOAL_LIST: 'updateGoalList',
  /**
   * Commands this host's inbound registry declares `unsupported(...)`
   * (see `unsupportedCommands` in `@shared/utils/dispatcher`), sent once at
   * webview-ready. Drives the frontend's capability-derived UI (e.g. hiding
   * the "Open VS Code Settings" button on desktop) instead of an
   * `isDesktopHost` check.
   */
  SET_UNSUPPORTED_COMMANDS: 'setUnsupportedCommands',
} as const;
