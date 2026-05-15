/**
 * Command constants for the settings view.
 */
import { COMMON_COMMANDS } from './commonCommands';

/**
 * Command string literals for settings view schema definitions.
 * Defined here (not in settingsViewMessages.ts) to avoid circular dependency:
 * commands.ts → settingsViewMessages.ts → memoryViewMessages.ts → commands.ts
 */
export const SETTINGS_VIEW_CMD = {
  // Navigation commands
  SET_TAB: 'setTab',
  OPEN_VSCODE_SETTINGS: 'openVscodeSettings',
  // Memory commands
  GET_MEMORY_DATA: 'getMemoryData',
  GET_MEMORY_PREVIEW: 'getMemoryPreview',
  OPEN_MEMORY_FILE: 'openMemoryFile',
  OPEN_MEMORY_FOLDER: 'openMemoryFolder',
  DELETE_MEMORY: 'deleteMemory',
  GET_MEMORY_ENABLED: 'getMemoryEnabled',
  SET_MEMORY_ENABLED: 'setMemoryEnabled',
  PIN_MEMORY: 'pinMemory',
  UNPIN_MEMORY: 'unpinMemory',
  // History commands
  GET_HISTORY_DATA: 'getHistoryData',
  RERUN_AGENT: 'rerunAgent',
  RESTORE_AGENT: 'restoreAgent',
  DELETE_AGENT: 'deleteAgent',
  CLEAR_HISTORY: 'clearHistory',
  EXPORT_CHAT_MD: 'exportChatMd',
  EXPORT_CHAT_TEX: 'exportChatTex',
  // Profile commands
  GET_PROFILE_DATA: 'getProfileData',
  SELECT_AGENT: 'selectAgent',
  SIGN_IN: 'signIn',
  SIGN_OUT: 'signOut',
  SET_API_ACCESS_MODE: 'setApiAccessMode',
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
  SET_NESTED_DELEGATION_MAX_DEPTH: 'setNestedDelegationMaxDepth',
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
  // Odyssey settings tab — read-only. State transitions are model-driven
  // via the odyssey() tool; the user only observes here. There are no
  // pause/resume/abandon/edit commands by design.
  GET_ODYSSEY_LIST: 'getOdysseyList',
  REVEAL_ODYSSEY_STREAM: 'revealOdysseyStream',
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
  UPDATE_ODYSSEY_LIST: 'updateOdysseyList',
} as const;
