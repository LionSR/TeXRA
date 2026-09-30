/** Webview IPC command-name constants, grouped per view. */

export const COMMON_COMMANDS = {
  WEBVIEW_READY: 'webviewReady',
} as const;

/** Settings-view command literals, both directions. */
export const SETTINGS_VIEW_COMMANDS = {
  ...COMMON_COMMANDS,
  // Schema-referenced: mostly inbound (webview → host), plus a few outbound
  // ones such as `SET_TAB` and the auth-status updates.
  // Navigation commands
  SET_TAB: 'setTab',
  // Memory commands
  GET_MEMORY_DATA: 'getMemoryData',
  GET_MEMORY_PREVIEW: 'getMemoryPreview',
  OPEN_MEMORY_FILE: 'openMemoryFile',
  OPEN_MEMORY_FOLDER: 'openMemoryFolder',
  DELETE_MEMORY: 'deleteMemory',
  PIN_MEMORY: 'pinMemory',
  UNPIN_MEMORY: 'unpinMemory',
  // Profile commands
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
  // Installed plugin actions (install, enable, disable, update, remove)
  PLUGIN_ACTION: 'pluginAction',
  // GitHub token commands (for PR subscription tool)
  UPDATE_GITHUB_TOKEN_STATUS: 'updateGitHubTokenStatus',
  SET_GITHUB_TOKEN: 'setGitHubToken',
  REMOVE_GITHUB_TOKEN: 'removeGitHubToken',
  OPEN_GITHUB_TOKEN_URL: 'openGitHubTokenUrl',
  // Subscription sign-in status, provider-keyed in its payload.
  UPDATE_SUBSCRIPTION_AUTH_STATUS: 'updateSubscriptionAuthStatus',
  // Subscription sign-in commands, provider-keyed in their payload.
  SIGN_IN_SUBSCRIPTION: 'signInSubscription',
  SIGN_OUT_SUBSCRIPTION: 'signOutSubscription',
  SET_SUBSCRIPTION_PREFERENCE: 'setSubscriptionPreference',
  GET_SUBSCRIPTION_USAGE: 'getSubscriptionUsage',
  UPDATE_PR_SUBSCRIPTIONS: 'updatePRSubscriptions',
  UNSUBSCRIBE_PR: 'unsubscribePR',
  OPEN_PR_SUBSCRIPTION_STREAM: 'openPRSubscriptionStream',
  // LaTeX settings commands
  APPLY_LATEX_SETTINGS: 'applyLatexSettings',
  INSTALL_LATEX_WORKSHOP: 'installLatexWorkshop',
  RUN_INSTALL_COMMAND: 'runInstallCommand',
  // Outbound-only commands (backend → frontend, not schema-validated)
  UPDATE_MEMORY: 'updateMemory',
  UPDATE_MEMORY_PREVIEW: 'updateMemoryPreview',
  UPDATE_PROFILE: 'updateProfile',
  UPDATE_MODEL_SELECTION: 'updateModelSelection',
  UPDATE_AGENT_SELECTION: 'updateAgentSelection',
  UPDATE_CUSTOM_AGENT_DIR: 'updateCustomAgentDir',
  UPDATE_AGENT_MODE_PRESETS: 'updateAgentModePresets',
  // Every catalog-derived snapshot in `settingsViewMessages.ts`'s
  // derived-snapshot list, keyed by its `snapshot` field.
  UPDATE_SETTINGS_SNAPSHOT: 'updateSettingsSnapshot',
  UPDATE_SKILLS_LIST: 'updateSkillsList',
  UPDATE_TOOL_DASHBOARD: 'updateToolDashboard',
  UPDATE_SUBSCRIPTION_USAGE: 'updateSubscriptionUsage',
  UPDATE_LATEX_SETTINGS_STATUS: 'updateLatexSettingsStatus',
} as const;
