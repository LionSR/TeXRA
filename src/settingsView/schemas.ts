/**
 * Zod schemas and command constants for Settings View.
 * Single source of truth for message protocol.
 */
import { z } from 'zod';

// =============================================================================
// Command Constants
// =============================================================================

export const SETTINGS_VIEW_COMMANDS = {
  // Common (inherited)
  THEME_SET: 'setTheme',
  DEBUG_MODE_SET: 'setDebugMode',
  STATE_RESTORE: 'restoreState',
  WEBVIEW_READY: 'webviewReady',
  ERROR: 'error',

  // Extension → Webview
  SET_INITIAL_DATA: 'setInitialData',
  SET_MODELS_DATA: 'setModelsData',
  SET_AGENTS_DATA: 'setAgentsData',
  SET_LATEX_DATA: 'setLatexData',
  SET_MEMORY_DATA: 'setMemoryData',
  SET_HISTORY_DATA: 'setHistoryData',
  SET_ACCOUNT_DATA: 'setAccountData',
  SELECT_TAB: 'selectTab',
  HISTORY_CLEARED: 'historyCleared',

  // Webview → Extension
  GET_INITIAL_DATA: 'getInitialData',
  TAB_CHANGED: 'tabChanged',
  SAVE_ENABLED_MODELS: 'saveEnabledModels',
  SAVE_ENABLED_AGENTS: 'saveEnabledAgents',
  SAVE_SETTING: 'saveSetting',
  SET_API_KEY: 'setApiKey',
  DELETE_API_KEY: 'deleteApiKey',
  SIGN_IN: 'signIn',
  SIGN_OUT: 'signOut',
  OPEN_PROVIDER_URL: 'openProviderUrl',
  BROWSE_FILE: 'browseFile',

  // History tab (from historyView)
  RERUN_AGENT: 'rerunAgent',
  RESTORE_AGENT: 'restoreAgent',
  DELETE_HISTORY_ITEM: 'deleteHistoryItem',
  CLEAR_HISTORY: 'clearHistory',

  // Memory tab (from memoryView)
  OPEN_MEMORY_FILE: 'openMemoryFile',
  OPEN_MEMORY_FOLDER: 'openMemoryFolder',
  DELETE_MEMORY: 'deleteMemory',
  REFRESH_MEMORY: 'refreshMemory',
  SET_MEMORY_ENABLED: 'setMemoryEnabled',

  // Agents tab actions
  OPEN_AGENT_SOURCE: 'openAgentSource',
  DELETE_AGENT: 'deleteAgent',
} as const;

// =============================================================================
// Shared Schemas
// =============================================================================

export const SettingsTabSchema = z.enum([
  'models',
  'agents',
  'latex',
  'memory',
  'history',
]);
export type SettingsTab = z.infer<typeof SettingsTabSchema>;

// Provider status for Models tab
export const ProviderStatusSchema = z.enum([
  'configured',
  'env',
  'missing',
  'server',
]);
export type ProviderStatus = z.infer<typeof ProviderStatusSchema>;

// Provider identifiers
export const ProviderIdSchema = z.enum([
  'anthropic',
  'openai',
  'google',
  'openRouter',
  'deepseek',
  'xai',
  'moonshot',
  'dashscope',
]);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

// =============================================================================
// Model Data Schemas
// =============================================================================

export const ModelCapabilitiesSchema = z.object({
  reasoning: z.boolean().optional(),
  vision: z.boolean().optional(),
  pdf: z.boolean().optional(),
  audio: z.boolean().optional(),
  tools: z.boolean().optional(),
  caching: z.boolean().optional(),
});
export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;

export const ModelDisplayDataSchema = z.object({
  id: z.string(),
  name: z.string(),
  fullName: z.string(),
  provider: z.string(),
  contextWindow: z.number(),
  inputPrice: z.number().optional(),
  outputPrice: z.number().optional(),
  capabilities: ModelCapabilitiesSchema.optional(),
  enabled: z.boolean(),
  isRecommended: z.boolean().optional(),
  status: ProviderStatusSchema.optional(),
});
export type ModelDisplayData = z.infer<typeof ModelDisplayDataSchema>;

export const ProviderDisplayDataSchema = z.object({
  id: ProviderIdSchema,
  name: z.string(),
  status: ProviderStatusSchema,
  modelCount: z.number(),
  keyUrl: z.string(),
  envVar: z.string(),
  streamingEnabled: z.boolean().optional(),
});
export type ProviderDisplayData = z.infer<typeof ProviderDisplayDataSchema>;

// =============================================================================
// Agent Data Schemas
// =============================================================================

export const AgentSourceSchema = z.enum([
  'builtIn',
  'builtInToolUse',
  'custom',
  'remote',
]);
export type AgentSource = z.infer<typeof AgentSourceSchema>;

export const AgentCategorySchema = z.enum(['workflow', 'toolUse']);
export type AgentCategory = z.infer<typeof AgentCategorySchema>;

export const AgentTypeSchema = z.enum([
  'CoT',
  'direct',
  'toolUse',
  'merge',
  'reflect',
]);
export type AgentType = z.infer<typeof AgentTypeSchema>;

export const AgentDisplayDataSchema = z.object({
  name: z.string(),
  source: AgentSourceSchema,
  category: AgentCategorySchema,
  agentType: AgentTypeSchema,
  description: z.string().optional(),
  rounds: z.number().optional(),
  inherits: z.string().optional(),
  enabled: z.boolean(),
});
export type AgentDisplayData = z.infer<typeof AgentDisplayDataSchema>;

// =============================================================================
// LaTeX Settings Schema
// =============================================================================

export const LatexSettingsSchema = z.object({
  // Formatter
  formatter: z.enum(['latexindent', 'tex-fmt', 'none']).optional(),
  latexindentConfig: z.string().optional(),
  texfmtConfig: z.string().optional(),
  showLatexindentWarning: z.boolean().optional(),

  // LaTeXdiff
  latexdiffMathMarkup: z.enum(['off', 'whole', 'coarse', 'fine']).optional(),
  latexdiffTimeoutMs: z.number().optional(),
  latexdiffPictureEnvironments: z.string().optional(),
  latexdiffGenerateBetweenRoundDiffs: z.boolean().optional(),

  // TikZ
  tikzInputDirectory: z.string().optional(),
  includeWorkspaceInTexinputs: z.boolean().optional(),
  tikzTemplate: z.string().optional(),

  // Replacements
  wrapCritiqueInAlign: z.boolean().optional(),
  enabledReplacements: z.array(z.string()).optional(),
  enabledReplacementsRegex: z.array(z.string()).optional(),
});
export type LatexSettings = z.infer<typeof LatexSettingsSchema>;

// =============================================================================
// Memory Data Schemas
// =============================================================================

export interface MemoryFile {
  name: string;
  path: string;
  size: number;
  modified: string;
  preview?: string;
  lineCount?: number;
  isDirectory?: boolean;
  children?: MemoryFile[];
}

export const MemoryFileSchema: z.ZodType<MemoryFile> = z.object({
  name: z.string(),
  path: z.string(),
  size: z.number(),
  modified: z.string(),
  preview: z.string().optional(),
  lineCount: z.number().optional(),
  isDirectory: z.boolean().optional(),
  children: z.array(z.lazy(() => MemoryFileSchema)).optional(),
});

// =============================================================================
// History Data Schemas
// =============================================================================

export const HistoryItemSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  agentName: z.string(),
  modelName: z.string(),
  inputFile: z.string().optional(),
  inputFiles: z.array(z.string()).optional(),
  outputFiles: z.array(z.string()).optional(),
  referenceFile: z.string().nullable().optional(),
  referenceFiles: z.array(z.string()).optional(),
  auxiliaryFile: z.string().nullable().optional(),
  auxiliaryFiles: z.array(z.string()).optional(),
  mediaFile: z.string().nullable().optional(),
  mediaFiles: z.array(z.string()).optional(),
  instruction: z.string().optional(),
  sessionKind: z.enum(['workflow', 'tool-use']).optional(),
  toolConfig: z.record(z.string(), z.boolean()).optional(),
});
export type HistoryItem = z.infer<typeof HistoryItemSchema>;

// =============================================================================
// Account Data Schema
// =============================================================================

export const AccountDataSchema = z.object({
  authenticated: z.boolean(),
  email: z.string().optional(),
  userId: z.string().optional(),
  tier: z.enum(['free', 'Max', 'Ultra']).optional(),
  accessExpiration: z.string().optional(),
  useIncludedAccess: z.boolean().optional(),
});
export type AccountData = z.infer<typeof AccountDataSchema>;

// =============================================================================
// Select Options Schema (dropdown options - single source of truth)
// =============================================================================

export const SelectOptionSchema = z.object({
  value: z.string(),
  label: z.string(),
});
export type SelectOption = z.infer<typeof SelectOptionSchema>;

export const SelectOptionsSchema = z.object({
  storageMode: z.array(SelectOptionSchema),
  sessionRetention: z.array(SelectOptionSchema),
  maxRetryAttempts: z.array(SelectOptionSchema),
  formatter: z.array(SelectOptionSchema),
  mathMarkup: z.array(SelectOptionSchema),
});
export type SelectOptions = z.infer<typeof SelectOptionsSchema>;

// =============================================================================
// Initial Data Schema (sent on load)
// =============================================================================

export const InitialDataSchema = z.object({
  account: AccountDataSchema,
  models: z.array(ModelDisplayDataSchema),
  enabledModels: z.array(z.string()),
  providers: z.array(ProviderDisplayDataSchema),
  agents: z.array(AgentDisplayDataSchema),
  enabledAgents: z.array(z.string()),
  enabledToolUseAgents: z.array(z.string()),
  latexSettings: LatexSettingsSchema,
  memoryFiles: z.array(MemoryFileSchema).optional(),
  memoryEnabled: z.boolean().optional(),
  history: z.array(HistoryItemSchema).optional(),
  selectedTab: SettingsTabSchema.optional(),
  selectOptions: SelectOptionsSchema.optional(),
  customAgentsDirectory: z.string().optional(),
});
export type InitialData = z.infer<typeof InitialDataSchema>;

// =============================================================================
// Message Schemas (Extension → Webview)
// =============================================================================

export const SetInitialDataMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.SET_INITIAL_DATA),
  data: InitialDataSchema,
});

export const SetAccountDataMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.SET_ACCOUNT_DATA),
  data: AccountDataSchema,
});

export const SelectTabMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.SELECT_TAB),
  tab: SettingsTabSchema,
});

export const SetModelsDataMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.SET_MODELS_DATA),
  models: z.array(ModelDisplayDataSchema),
  enabledModels: z.array(z.string()),
  providers: z.array(ProviderDisplayDataSchema),
});

export const SetAgentsDataMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.SET_AGENTS_DATA),
  agents: z.array(AgentDisplayDataSchema),
  enabledAgents: z.array(z.string()),
  enabledToolUseAgents: z.array(z.string()),
});

export const SetHistoryDataMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.SET_HISTORY_DATA),
  historyItems: z.array(HistoryItemSchema),
});

export const HistoryClearedMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.HISTORY_CLEARED),
});

// =============================================================================
// Action Schemas (Webview → Extension)
// =============================================================================

export const GetInitialDataActionSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.GET_INITIAL_DATA),
});

export const TabChangedActionSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.TAB_CHANGED),
  tab: SettingsTabSchema,
});

export const SaveEnabledModelsActionSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.SAVE_ENABLED_MODELS),
  models: z.array(z.string()),
});

export const SaveEnabledAgentsActionSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.SAVE_ENABLED_AGENTS),
  agents: z.array(z.string()),
  toolUseAgents: z.array(z.string()),
});

export const SaveSettingActionSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.SAVE_SETTING),
  key: z.string(),
  value: z.unknown(),
  target: z.enum(['global', 'workspace']).optional(),
});

export const SetApiKeyActionSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.SET_API_KEY),
  provider: ProviderIdSchema,
  key: z.string(),
});

export const DeleteApiKeyActionSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.DELETE_API_KEY),
  provider: ProviderIdSchema,
});

export const OpenProviderUrlActionSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.OPEN_PROVIDER_URL),
  provider: ProviderIdSchema,
});

export const BrowseFileActionSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.BROWSE_FILE),
  settingKey: z.string(),
  dialogTitle: z.string().optional(),
  filters: z.record(z.string(), z.array(z.string())).optional(),
});

export const HistoryActionSchema = z.object({
  command: z.enum([
    SETTINGS_VIEW_COMMANDS.RERUN_AGENT,
    SETTINGS_VIEW_COMMANDS.RESTORE_AGENT,
    SETTINGS_VIEW_COMMANDS.DELETE_HISTORY_ITEM,
  ]),
  historyId: z.string(),
});

export const MemoryActionSchema = z.object({
  command: z.enum([
    SETTINGS_VIEW_COMMANDS.OPEN_MEMORY_FILE,
    SETTINGS_VIEW_COMMANDS.DELETE_MEMORY,
  ]),
  path: z.string(),
});

export const MemoryToggleActionSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.SET_MEMORY_ENABLED),
  enabled: z.boolean(),
});

export const OpenMemoryFolderActionSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.OPEN_MEMORY_FOLDER),
});

export const RefreshMemoryActionSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.REFRESH_MEMORY),
});

export const ClearHistoryActionSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.CLEAR_HISTORY),
});

export const SignInActionSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.SIGN_IN),
});

export const SignOutActionSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.SIGN_OUT),
});

export const OpenAgentSourceActionSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.OPEN_AGENT_SOURCE),
  agentName: z.string(),
});

export const DeleteAgentActionSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.DELETE_AGENT),
  agentName: z.string(),
});
