import { COMMON_COMMANDS } from './commonCommands';
import { MEMORY_VIEW_COMMANDS } from './memoryViewCommands';
import { HISTORY_VIEW_COMMANDS } from './historyViewCommands';
import { PROFILE_VIEW_COMMANDS } from './profileViewCommands';

/**
 * Command string literals for settings view schema definitions.
 * Defined here (not in settingsViewMessages.ts) to avoid circular dependency:
 * commands.ts → settingsViewMessages.ts → memoryViewMessages.ts → commands.ts
 *
 * Memory/History/Profile inbound commands reference their own view's
 * command map (the single source of truth for those literals) instead of
 * repeating the string values, so the two can't drift.
 */
export const SETTINGS_VIEW_CMD = {
  // Navigation commands
  SET_TAB: 'setTab',
  OPEN_VSCODE_SETTINGS: 'openVscodeSettings',
  // Memory commands
  GET_MEMORY_DATA: MEMORY_VIEW_COMMANDS.GET_MEMORY_DATA,
  GET_MEMORY_PREVIEW: MEMORY_VIEW_COMMANDS.GET_MEMORY_PREVIEW,
  OPEN_MEMORY_FILE: MEMORY_VIEW_COMMANDS.OPEN_MEMORY_FILE,
  OPEN_MEMORY_FOLDER: MEMORY_VIEW_COMMANDS.OPEN_MEMORY_FOLDER,
  DELETE_MEMORY: MEMORY_VIEW_COMMANDS.DELETE_MEMORY,
  GET_MEMORY_ENABLED: MEMORY_VIEW_COMMANDS.GET_MEMORY_ENABLED,
  SET_MEMORY_ENABLED: MEMORY_VIEW_COMMANDS.SET_MEMORY_ENABLED,
  PIN_MEMORY: MEMORY_VIEW_COMMANDS.PIN_MEMORY,
  UNPIN_MEMORY: MEMORY_VIEW_COMMANDS.UNPIN_MEMORY,
  // History commands
  GET_HISTORY_DATA: HISTORY_VIEW_COMMANDS.GET_HISTORY_DATA,
  RERUN_AGENT: HISTORY_VIEW_COMMANDS.RERUN_AGENT,
  RESTORE_AGENT: HISTORY_VIEW_COMMANDS.RESTORE_AGENT,
  DELETE_AGENT: HISTORY_VIEW_COMMANDS.DELETE_AGENT,
  CLEAR_HISTORY: HISTORY_VIEW_COMMANDS.CLEAR_HISTORY,
  EXPORT_CHAT_MD: HISTORY_VIEW_COMMANDS.EXPORT_CHAT_MD,
  EXPORT_CHAT_TEX: HISTORY_VIEW_COMMANDS.EXPORT_CHAT_TEX,
  EXPORT_CHAT_HTML: HISTORY_VIEW_COMMANDS.EXPORT_CHAT_HTML,
  // Profile commands
  GET_PROFILE_DATA: PROFILE_VIEW_COMMANDS.GET_PROFILE_DATA,
  SELECT_AGENT: PROFILE_VIEW_COMMANDS.SELECT_AGENT,
  SIGN_IN: PROFILE_VIEW_COMMANDS.SIGN_IN,
  SIGN_OUT: PROFILE_VIEW_COMMANDS.SIGN_OUT,
  SET_API_ACCESS_MODE: PROFILE_VIEW_COMMANDS.SET_API_ACCESS_MODE,
  SET_PROVIDER_KEY: 'setProviderKey',
  REMOVE_PROVIDER_KEY: 'removeProviderKey',
  OPEN_PROVIDER_KEY_URL: 'openProviderKeyUrl',
  SET_PROVIDER_STREAMING: 'setProviderStreaming',
  SET_PROVIDER_ENDPOINT: 'setProviderEndpoint',
  SET_GLOBAL_STREAMING: 'setGlobalStreaming',
  SET_PROVIDER_VSCODE_SETTING: 'setProviderVscodeSetting',
  OPEN_EXTERNAL_URL: 'openExternalUrl',
  // Model selection commands
  GET_MODEL_SELECTION: 'getModelSelection',
  SET_MODEL_ENABLED: 'setModelEnabled',
  SET_HELPER_MODEL: 'setPolishModel',
  SET_MODEL_REASONING_LEVEL: 'setModelReasoningLevel',
  SET_PREFER_SHORT_MODEL_NAMES: 'setPreferShortModelNames',
  // Agent selection commands
  GET_AGENT_SELECTION: 'getAgentSelection',
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
  GET_CUSTOM_AGENT_DIR: 'getCustomAgentDir',
  SET_CUSTOM_AGENT_DIR: 'setCustomAgentDir',
  RESET_CUSTOM_AGENT_DIR: 'resetCustomAgentDir',
  // Multi-Agent commands
  GET_SUPER_YOLO_ENABLED: 'getSuperYoloEnabled',
  SET_SUPER_YOLO_ENABLED: 'setSuperYoloEnabled',
  SET_ALLOW_ORCHESTRATOR_KILL: 'setAllowOrchestratorKill',
  SET_DETACH_SUBAGENTS_ON_STOP: 'setDetachSubagentsOnStop',
  APPLY_AGENT_MODE_PRESET: 'applyAgentModePreset',
  SAVE_AGENT_MODE_PRESET: 'saveAgentModePreset',
  DELETE_AGENT_MODE_PRESET: 'deleteAgentModePreset',
  GET_AGENT_MODE_PRESETS: 'getAgentModePresets',
  // Approval settings commands
  GET_APPROVAL_SETTINGS: 'getApprovalSettings',
  SET_BASH_APPROVAL_ENABLED: 'setBashApprovalEnabled',
  SET_CODEX_SANDBOX_MODE: 'setCodexSandboxMode',
  SET_CODEX_REASONING_EFFORT: 'setCodexReasoningEffort',
  SET_CODEX_APPROVAL_POLICY: 'setCodexApprovalPolicy',
  SET_CLAUDE_AGENT_MODEL: 'setClaudeAgentModel',
  SET_CLAUDE_AGENT_PERMISSION_MODE: 'setClaudeAgentPermissionMode',
  SET_CLAUDE_AGENT_EFFORT: 'setClaudeAgentEffort',
  // Tool dashboard commands
  GET_TOOL_DASHBOARD_DATA: 'getToolDashboardData',
  OPEN_TOOL_INSTALL_URL: 'openToolInstallUrl',
  INSTALL_TOOL_EXTENSION: 'installToolExtension',
  RECHECK_TOOL_STATUS: 'recheckToolStatus',
  TOGGLE_TOOL: 'toggleTool',
  RUN_TOOL_COMMAND: 'runToolCommand',
  // Git settings commands
  GET_GIT_AUTHOR_SETTINGS: 'getGitAuthorSettings',
  SET_GIT_MARK_COMMITS: 'setGitMarkCommits',
  SET_GIT_AUTHOR_NAME: 'setGitAuthorName',
  SET_GIT_AUTHOR_EMAIL: 'setGitAuthorEmail',
  SET_GIT_WORKTREE_SUPPORT: 'setGitWorktreeSupport',
  // GitHub token commands (for PR subscription tool)
  GET_GITHUB_TOKEN_STATUS: 'getGitHubTokenStatus',
  UPDATE_GITHUB_TOKEN_STATUS: 'updateGitHubTokenStatus',
  SET_GITHUB_TOKEN: 'setGitHubToken',
  REMOVE_GITHUB_TOKEN: 'removeGitHubToken',
  OPEN_GITHUB_TOKEN_URL: 'openGitHubTokenUrl',
  // ChatGPT subscription (Codex) sign-in commands
  GET_CHATGPT_AUTH_STATUS: 'getChatGptAuthStatus',
  UPDATE_CHATGPT_AUTH_STATUS: 'updateChatGptAuthStatus',
  SIGN_IN_CHATGPT: 'signInChatGpt',
  SIGN_OUT_CHATGPT: 'signOutChatGpt',
  SET_CHATGPT_PREFER_SUBSCRIPTION: 'setChatGptPreferSubscription',
  SET_CHATGPT_SUBSCRIPTION_TOOL_USE_ONLY: 'setChatGptSubscriptionToolUseOnly',
  GET_DESKTOP_CRASH_REPORTING: 'getDesktopCrashReporting',
  UPDATE_DESKTOP_CRASH_REPORTING: 'updateDesktopCrashReporting',
  SET_DESKTOP_CRASH_REPORTING_ENABLED: 'setDesktopCrashReportingEnabled',
  SET_DESKTOP_CRASH_REPORTING_DSN: 'setDesktopCrashReportingDsn',
  GET_PR_SUBSCRIPTIONS: 'getPRSubscriptions',
  UPDATE_PR_SUBSCRIPTIONS: 'updatePRSubscriptions',
  UNSUBSCRIBE_PR: 'unsubscribePR',
  OPEN_PR_SUBSCRIPTION_STREAM: 'openPRSubscriptionStream',
  // LaTeX settings commands
  GET_LATEX_SETTINGS_STATUS: 'getLatexSettingsStatus',
  APPLY_LATEX_SETTINGS: 'applyLatexSettings',
  INSTALL_LATEX_WORKSHOP: 'installLatexWorkshop',
  RUN_INSTALL_COMMAND: 'runInstallCommand',
  // LaTeX/compile/diff config (storage-backed, migrated from VS Code config)
  GET_LATEX_CONFIG_VALUES: 'getLatexConfigValues',
  SET_LATEX_CONFIG_VALUE: 'setLatexConfigValue',
  // Experimental settings
  GET_INLINE_CRITICISM_ENABLED: 'getInlineCriticismEnabled',
  SET_INLINE_CRITICISM_ENABLED: 'setInlineCriticismEnabled',
  GET_GOAL_LIST: 'getGoalList',
  REVEAL_GOAL_STREAM: 'revealGoalStream',
} as const;

// Settings view specific commands (combines Memory, History, and Profile views)
// SETTINGS_VIEW_CMD is the source of truth; outbound-only commands are added here
export const SETTINGS_VIEW_COMMANDS = {
  ...COMMON_COMMANDS,
  ...SETTINGS_VIEW_CMD,
  // Outbound-only commands (backend → frontend, not schema-validated)
  UPDATE_MEMORY: 'updateMemory',
  UPDATE_MEMORY_PREVIEW: 'updateMemoryPreview',
  UPDATE_MEMORY_ENABLED: 'updateMemoryEnabled',
  UPDATE_HISTORY: 'updateHistory',
  HISTORY_CLEARED: 'historyCleared',
  UPDATE_PROFILE: 'updateProfile',
  UPDATE_MODEL_SELECTION: 'updateModelSelection',
  UPDATE_AGENT_SELECTION: 'updateAgentSelection',
  UPDATE_CUSTOM_AGENT_DIR: 'updateCustomAgentDir',
  UPDATE_SUPER_YOLO_ENABLED: 'updateSuperYoloEnabled',
  UPDATE_AGENT_MODE_PRESETS: 'updateAgentModePresets',
  UPDATE_APPROVAL_SETTINGS: 'updateApprovalSettings',
  UPDATE_TOOL_DASHBOARD: 'updateToolDashboard',
  UPDATE_GIT_AUTHOR_SETTINGS: 'updateGitAuthorSettings',
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
