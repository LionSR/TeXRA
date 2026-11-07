/** Webview IPC command-name constants, grouped per view. */
import { Schema } from 'effect';

const COMMON_COMMANDS = {
  WEBVIEW_READY: 'webviewReady',
} as const;

/** A host theme kind, as a host reports it to its webviews. */
export type Theme = 'dark' | 'light' | 'high-contrast';

/** Theme kinds as reported by the Electron desktop host. */
export const DESKTOP_THEME_KIND = {
  DARK: 'dark',
  LIGHT: 'light',
  HIGH_CONTRAST: 'high-contrast',
} as const satisfies Record<string, Theme>;

/** The message a webview posts once it can receive its first snapshot. */
export const WebviewReadyMessageSchema = Schema.Struct({
  command: Schema.Literal(COMMON_COMMANDS.WEBVIEW_READY),
});

/** Settings-view command literals, both directions. */
export const SETTINGS_VIEW_COMMANDS = {
  ...COMMON_COMMANDS,
  // Inbound (webview → host), except `SET_TAB` and the three at the end.
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
  // Agent selection commands
  OPEN_AGENT_YAML: 'openAgentYaml',
  SET_AGENT_ENABLED: 'setAgentEnabled',
  SET_ALL_AGENTS_ENABLED: 'setAllAgentsEnabled',
  OPEN_AGENT_FOLDER: 'openAgentFolder',
  CREATE_AGENT: 'createAgent',
  CUSTOMIZE_AGENT: 'customizeAgent',
  DELETE_CUSTOM_AGENT: 'deleteCustomAgent',
  KEEP_CUSTOM_AGENT: 'keepCustomAgent',
  REVEAL_AGENT_FILE: 'revealAgentFile',
  // Custom agent directory commands
  SET_CUSTOM_AGENT_DIR: 'setCustomAgentDir',
  RESET_CUSTOM_AGENT_DIR: 'resetCustomAgentDir',
  // Team commands
  APPLY_AGENT_MODE_PRESET: 'applyAgentModePreset',
  SAVE_AGENT_MODE_PRESET: 'saveAgentModePreset',
  DELETE_AGENT_MODE_PRESET: 'deleteAgentModePreset',
  // Generic settings-view scalar write. The backend looks up {key, value} in the
  // unified catalog, validates and persists it using the row's metadata, then
  // refreshes the row's owning snapshot.
  UPDATE_STATE_SETTING: 'updateStateSetting',
  SET_SKILL_ENABLED: 'setSkillEnabled',
  // Tool dashboard commands
  INSTALL_EXTENSION: 'installExtension',
  RECHECK_TOOL_STATUS: 'recheckToolStatus',
  TOGGLE_TOOL: 'toggleTool',
  RUN_TOOL_COMMAND: 'runToolCommand',
  // Plugin page actions: install, enable, disable, update, remove an installed
  // plugin, and open the MCP config file
  PLUGIN_ACTION: 'pluginAction',
  // GitHub token commands (for PR subscription tool)
  SET_GITHUB_TOKEN: 'setGitHubToken',
  REMOVE_GITHUB_TOKEN: 'removeGitHubToken',
  OPEN_GITHUB_TOKEN_URL: 'openGitHubTokenUrl',
  // Subscription sign-in commands, provider-keyed in their payload.
  SIGN_IN_SUBSCRIPTION: 'signInSubscription',
  SIGN_OUT_SUBSCRIPTION: 'signOutSubscription',
  SET_SUBSCRIPTION_PREFERENCE: 'setSubscriptionPreference',
  GET_SUBSCRIPTION_USAGE: 'getSubscriptionUsage',
  UNSUBSCRIBE_PR: 'unsubscribePR',
  OPEN_PR_SUBSCRIPTION_STREAM: 'openPRSubscriptionStream',
  // LaTeX settings commands
  APPLY_LATEX_SETTINGS: 'applyLatexSettings',
  RUN_INSTALL_COMMAND: 'runInstallCommand',
  // Outbound (host → webview), each a member of the validated outbound union.
  // What the host knows for the view, as one record patched field by field.
  UPDATE_HOST_STATE: 'updateHostState',
  UPDATE_MEMORY_PREVIEW: 'updateMemoryPreview',
  // Every catalog-derived snapshot in `settingsViewMessages.ts`'s
  // derived-snapshot list, keyed by its `snapshot` field.
  UPDATE_SETTINGS_SNAPSHOT: 'updateSettingsSnapshot',
} as const;
