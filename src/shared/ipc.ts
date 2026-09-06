/** Webview IPC command-name constants, grouped per view. */

export const COMMON_COMMANDS = {
  WEBVIEW_READY: 'webviewReady',
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
  UPDATE_SKILLS_SETTINGS: 'updateSkillsSettings',
  UPDATE_SKILLS_LIST: 'updateSkillsList',
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
