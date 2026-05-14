/**
 * Schema definitions for SettingsView messages.
 *
 * Combines all messages from MemoryView, HistoryView, and ProfileView
 * into a single unified schema for the settings view.
 */
import { z } from 'zod';

import {
  SETTINGS_VIEW_CMD,
  SETTINGS_VIEW_COMMANDS,
} from '@common/webview/commands';
import {
  LATEX_CONFIG_FIELDS,
  LATEX_CONFIG_RANGES,
  LATEX_FORMATTER_VALUES,
  LATEXDIFF_MATH_MARKUP_VALUES,
} from '@shared/constants/latex';
// Re-export the canonical type so existing consumers that import
// `LatexConfigField` from this module continue to compile.
export type { LatexConfigField } from '@shared/constants/latex';
import {
  createDispatcher,
  type HandlerRegistry,
} from '@shared/utils/dispatcher';

// SETTINGS_VIEW_CMD is defined in commands.ts to avoid circular dependency.
// Re-exported here for consumers that expect it from the schema module.
import {
  AgentCategorySchema,
  AgentMetadataBaseSchema,
  AgentSourceSchema,
} from './agent';
import { AgentModePresetSchema } from './agentPresets';
import { NESTED_DELEGATION_DEPTH_RANGE } from '../constants/delegationPolicy';
import {
  DeleteMemoryMessageSchema,
  GetMemoryDataMessageSchema,
  GetMemoryEnabledMessageSchema,
  GetMemoryPreviewMessageSchema,
  OpenMemoryFileMessageSchema,
  OpenMemoryFolderMessageSchema,
  PinMemoryMessageSchema,
  SetMemoryEnabledMessageSchema,
  UnpinMemoryMessageSchema,
} from './memoryViewMessages';
import {
  ClearHistoryMessageSchema,
  DeleteAgentMessageSchema,
  ExportChatMdMessageSchema,
  ExportChatTexMessageSchema,
  GetHistoryDataMessageSchema,
  RerunAgentMessageSchema,
  RestoreAgentMessageSchema,
} from './historyViewMessages';
import { WebviewReadyMessageSchema } from './commonViewMessages';
import { commandOnly } from './messageFactories';
import {
  GetProfileDataMessageSchema,
  NumberVscodeSettingSchema,
  SelectAgentInboundMessageSchema,
  SetApiAccessModeInboundMessageSchema,
  SignInMessageSchema,
  SignOutMessageSchema,
} from './profileViewMessages';
import { StreamTabIdSchema } from './identifiers';
export { SETTINGS_VIEW_CMD };

/** Tab name order - single source of truth for tab indices */
export const SETTINGS_TAB_ORDER = [
  'MEMORY',
  'HISTORY',
  'MODELS',
  'AGENTS',
  'MULTI_AGENT',
  'TOOLS',
  'GIT',
  'LATEX',
] as const;

export type SettingsTabName = (typeof SETTINGS_TAB_ORDER)[number];

/** Tab indices derived from ordered array */
export const SETTINGS_TAB = Object.fromEntries(
  SETTINGS_TAB_ORDER.map((name, index) => [name, index]),
) as Record<SettingsTabName, number>;

export type SettingsTab = (typeof SETTINGS_TAB)[keyof typeof SETTINGS_TAB];

/** Outbound schema to switch tabs */
export const SetTabMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_CMD.SET_TAB),
  tabIndex: z
    .int()
    .min(0)
    .max(SETTINGS_TAB_ORDER.length - 1),
  agentSubTab: AgentCategorySchema.optional(),
});

export type SetTabMessage = z.infer<typeof SetTabMessageSchema>;

const CMD = SETTINGS_VIEW_CMD;

// Re-export data schemas from individual view messages
export {
  MemoryViewItemSchema,
  MemoryPreviewSchema,
  type MemoryViewItem,
  type MemoryPreview,
  type MemoryPathMessage,
  type MemoryDeleteMessage,
  type MemoryEnabledMessage,
} from './memoryViewMessages';

export {
  HistoryItemSchema,
  type HistoryItem,
  type HistoryIdMessage,
} from './historyViewMessages';

export {
  ProfileUserSchema,
  RemoteAgentSchema,
  ApiAccessModeSchema,
  TierConstantsSchema,
  ProviderKeyStatusSchema,
  ProviderVscodeSettingSchema,
  NumberVscodeSettingSchema,
  type ProfileUser,
  type RemoteAgent,
  type ApiAccessMode,
  type TierConstants,
  type ProviderKeyStatus,
  type ProviderVscodeSetting,
  type NumberVscodeSetting,
  type SelectAgentMessage,
  type SetApiAccessModeMessage,
} from './profileViewMessages';

// ============================================================
// Agent selection data schema
// ============================================================

/**
 * Agent selection data for the settings view.
 * Extends AgentMetadataBaseSchema (name, category, description) with
 * settings-specific fields for UI state.
 */
export const AgentSelectionItemSchema = AgentMetadataBaseSchema.extend({
  source: AgentSourceSchema,
  hasPath: z.boolean(),
  filePath: z.string().optional(),
  tools: z.array(z.string()).optional(),
  enabled: z.boolean(),
});
export type AgentSelectionItem = z.infer<typeof AgentSelectionItemSchema>;

/** Outbound: backend → frontend agent selection data */
export const UpdateAgentSelectionMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_SELECTION),
  workflow: z.array(AgentSelectionItemSchema),
  toolUse: z.array(AgentSelectionItemSchema),
});
export type UpdateAgentSelectionMessage = z.infer<
  typeof UpdateAgentSelectionMessageSchema
>;

// ============================================================
// Model selection data schema
// ============================================================

/** Reasoning effort levels that a user can select. */
export const ReasoningLevelSchema = z.enum(['none', 'low', 'medium', 'high']);
export type ReasoningLevel = z.infer<typeof ReasoningLevelSchema>;

export const ModelSelectionItemSchema = z.object({
  name: z.string(),
  label: z.string(),
  provider: z.string(),
  enabled: z.boolean(),
  deprecated: z.boolean(),
  contextWindow: z.string().optional(),
  cost: z.string().optional(),
  /** Whether this model supports user-configurable reasoning effort. */
  supportsReasoningLevel: z.boolean().optional(),
  /** The model's default reasoning level from its static config. */
  defaultReasoningLevel: ReasoningLevelSchema.optional(),
  /** The user's chosen reasoning level override (undefined = use default). */
  reasoningLevel: ReasoningLevelSchema.optional(),
  /** Included access relay cap applied to the default xhigh effort, if any. */
  includedAccessReasoningCap: ReasoningLevelSchema.optional(),
  /** Whether this model qualifies as a "fast first response" pick (price-based). */
  isFast: z.boolean().optional(),
});
export type ModelSelectionItem = z.infer<typeof ModelSelectionItemSchema>;

/** Outbound: backend → frontend model selection data */
export const UpdateModelSelectionMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION),
  models: z.array(ModelSelectionItemSchema),
  helperModel: z.string(),
  /** Whether the user prefers short (unpinned) model names. */
  preferShortModelNames: z.boolean(),
});
export type UpdateModelSelectionMessage = z.infer<
  typeof UpdateModelSelectionMessageSchema
>;

// ============================================================
// Custom agent directory data schema
// ============================================================

/** Outbound: backend → frontend custom agent directory info */
export const UpdateCustomAgentDirMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_CUSTOM_AGENT_DIR),
  path: z.string(),
  isDefault: z.boolean(),
});
export type UpdateCustomAgentDirMessage = z.infer<
  typeof UpdateCustomAgentDirMessageSchema
>;

// ============================================================
// Super YOLO enabled data schema
// ============================================================

/** Outbound: backend → frontend Super YOLO enabled toggle + reliability settings */
export const UpdateSuperYoloEnabledMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_SUPER_YOLO_ENABLED),
  enabled: z.boolean(),
  reliabilitySettings: z.array(NumberVscodeSettingSchema).prefault([]),
  allowOrchestratorKill: z.boolean().prefault(true),
  detachSubagentsOnStop: z.boolean().prefault(false),
  nestedDelegationMaxDepth: z
    .int()
    .min(NESTED_DELEGATION_DEPTH_RANGE.min)
    .max(NESTED_DELEGATION_DEPTH_RANGE.max)
    .prefault(NESTED_DELEGATION_DEPTH_RANGE.default),
});
export type UpdateSuperYoloEnabledMessage = z.infer<
  typeof UpdateSuperYoloEnabledMessageSchema
>;

// ============================================================
// Agent team data schema
// ============================================================

/** Outbound: backend → frontend agent teams (built-in + custom) */
export const UpdateAgentModePresetsMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_MODE_PRESETS),
  customPresets: z.array(AgentModePresetSchema),
});
export type UpdateAgentModePresetsMessage = z.infer<
  typeof UpdateAgentModePresetsMessageSchema
>;

// ============================================================
// Tool dashboard data schemas
// ============================================================

/** Status of a tool dependency */
export const ToolStatusSchema = z.enum(['available', 'not-found', 'unknown']);
export type ToolStatus = z.infer<typeof ToolStatusSchema>;

/** Category for grouping tools in the dashboard */
export const ToolCategorySchema = z.enum([
  'file',
  'latex',
  'academic',
  'web',
  'computation',
  'lean',
  'workflow',
  'system',
]);
export type ToolCategory = z.infer<typeof ToolCategorySchema>;

/** Individual tool within a group — carries an optional description for tooltips. */
export const ToolInfoSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
});
export type ToolInfo = z.infer<typeof ToolInfoSchema>;

/** Single tool entry in the dashboard */
export const ToolDashboardItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: ToolCategorySchema,
  description: z.string(),
  tools: z.array(ToolInfoSchema),
  status: ToolStatusSchema,
  requiresSetup: z.boolean(),
  statusLabel: z.string().optional(),
  installGuide: z.string().optional(),
  installUrl: z.string().optional(),
  installExtensionId: z.string().optional(),
  installCommand: z.string().optional(),
  authCommand: z.string().optional(),
  configNotes: z.string().optional(),
  statusDetail: z.string().optional(),
  authNote: z.string().optional(),
  toggleable: z.boolean().optional(),
  enabled: z.boolean().optional(),
});
export type ToolDashboardItem = z.infer<typeof ToolDashboardItemSchema>;

/** Outbound: backend → frontend tool dashboard data */
export const UpdateToolDashboardMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD),
  items: z.array(ToolDashboardItemSchema),
});
export type UpdateToolDashboardMessage = z.infer<
  typeof UpdateToolDashboardMessageSchema
>;

// ============================================================
// Approval settings data schema
// ============================================================

/** Valid Codex sandbox modes (mirrors CODEX_SANDBOX_MODES in codexConfig.ts). */
export const CodexSandboxModeSchema = z.enum([
  'read-only',
  'workspace-write',
  'danger-full-access',
]);
export type CodexSandboxMode = z.infer<typeof CodexSandboxModeSchema>;

/** Valid Codex reasoning effort levels (mirrors CODEX_REASONING_EFFORTS in codexConfig.ts). */
export const CodexReasoningEffortSchema = z.enum([
  'low',
  'medium',
  'high',
  'xhigh',
]);
export type CodexReasoningEffort = z.infer<typeof CodexReasoningEffortSchema>;

/** Valid Codex approval policies (mirrors CODEX_APPROVAL_POLICIES in codexConfig.ts). */
export const CodexApprovalPolicySchema = z.enum([
  'never',
  'on-request',
  'on-failure',
  'untrusted',
]);
export type CodexApprovalPolicy = z.infer<typeof CodexApprovalPolicySchema>;

/** Outbound: backend → frontend approval settings */
export const UpdateApprovalSettingsMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_APPROVAL_SETTINGS),
  bashApprovalEnabled: z.boolean(),
  codexSandboxMode: CodexSandboxModeSchema,
  codexReasoningEffort: CodexReasoningEffortSchema,
  codexApprovalPolicy: CodexApprovalPolicySchema,
});
export type UpdateApprovalSettingsMessage = z.infer<
  typeof UpdateApprovalSettingsMessageSchema
>;

// ============================================================
// Git author settings data schema
// ============================================================

/** Outbound: backend → frontend git author settings */
export const UpdateGitAuthorSettingsMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_GIT_AUTHOR_SETTINGS),
  markCommits: z.boolean(),
  authorName: z.string(),
  authorEmail: z.string(),
  worktreeSupport: z.boolean(),
});
export type UpdateGitAuthorSettingsMessage = z.infer<
  typeof UpdateGitAuthorSettingsMessageSchema
>;

/** Outbound: backend → frontend GitHub token status. */
export const UpdateGitHubTokenStatusMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_GITHUB_TOKEN_STATUS),
  /** 'secret' = stored in SecretStorage; 'env' = GITHUB_TOKEN env var; 'none' = missing. */
  status: z.enum(['secret', 'env', 'none']),
});
export type UpdateGitHubTokenStatusMessage = z.infer<
  typeof UpdateGitHubTokenStatusMessageSchema
>;

/** Outbound: backend → frontend desktop crash reporting status. */
export const UpdateDesktopCrashReportingMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_DESKTOP_CRASH_REPORTING),
  enabled: z.boolean(),
  configured: z.boolean(),
});
export type UpdateDesktopCrashReportingMessage = z.infer<
  typeof UpdateDesktopCrashReportingMessageSchema
>;

export const PRSubscriptionOwnerSchema = z.object({
  streamId: StreamTabIdSchema,
  label: z.string(),
});
export type PRSubscriptionOwner = z.infer<typeof PRSubscriptionOwnerSchema>;

export const PRSubscriptionEntrySchema = z.object({
  key: z.string().min(1),
  owners: z.array(PRSubscriptionOwnerSchema),
});
export type PRSubscriptionEntry = z.infer<typeof PRSubscriptionEntrySchema>;

/** Outbound: backend → frontend active PR subscriptions. */
export const UpdatePRSubscriptionsMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_PR_SUBSCRIPTIONS),
  subscriptions: z.array(PRSubscriptionEntrySchema),
});
export type UpdatePRSubscriptionsMessage = z.infer<
  typeof UpdatePRSubscriptionsMessageSchema
>;

// ============================================================
// LaTeX settings data schemas
// ============================================================

/** Status of each recommended LaTeX-related VS Code setting. */
export const LatexSettingsStatusSchema = z.object({
  outDir: z.boolean(),
  autoRevealExclude: z.boolean(),
  texDistributionInstalled: z.boolean(),
  latexWorkshopInstalled: z.boolean(),
  latexdiffInstalled: z.boolean(),
  latexindentInstalled: z.boolean(),
  texcountInstalled: z.boolean(),
  imageProcessingInstalled: z.boolean(),
  platform: z.enum(['darwin', 'win32', 'linux']),
  pdflatexPath: z.string().nullable(),
  latexmkPath: z.string().nullable(),
  latexdiffPath: z.string().nullable(),
  latexindentPath: z.string().nullable(),
  texcountPath: z.string().nullable(),
  ghostscriptPath: z.string().nullable(),
  graphicsmagickPath: z.string().nullable(),
  /** Detected package manager available on the system (null = none found). */
  packageManager: z.enum(['brew', 'apt', 'scoop']).nullable(),
});
export type LatexSettingsStatus = z.infer<typeof LatexSettingsStatusSchema>;

/** Shared default — used by SettingsApp and LaTeXTab before backend data arrives. */
export const DEFAULT_LATEX_SETTINGS_STATUS: LatexSettingsStatus = {
  outDir: false,
  autoRevealExclude: false,
  texDistributionInstalled: false,
  latexWorkshopInstalled: false,
  latexdiffInstalled: false,
  latexindentInstalled: false,
  texcountInstalled: false,
  imageProcessingInstalled: false,
  platform: 'linux',
  pdflatexPath: null,
  latexmkPath: null,
  latexdiffPath: null,
  latexindentPath: null,
  texcountPath: null,
  ghostscriptPath: null,
  graphicsmagickPath: null,
  packageManager: null,
};

/** Outbound: backend → frontend LaTeX settings status */
export const UpdateLatexSettingsStatusMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_SETTINGS_STATUS),
  settings: LatexSettingsStatusSchema,
});
export type UpdateLatexSettingsStatusMessage = z.infer<
  typeof UpdateLatexSettingsStatusMessageSchema
>;

/**
 * LaTeX/compile/diff configuration values, persisted in workspace storage.
 * Migrated from VS Code `texra.*` configuration. The frontend tab edits these
 * directly; the backend persists them via `workspaceSM`.
 *
 * Each property is optional so the UI can render either the user-set value
 * (when defined) or the documented default (when undefined). Numeric ranges
 * and enum values come from `@shared/constants/latex` so this schema, the UI,
 * and the runtime readers all stay in lockstep.
 */
export const LatexFormatterSchema = z.enum(LATEX_FORMATTER_VALUES);
export type LatexFormatter = z.infer<typeof LatexFormatterSchema>;

export const LatexdiffMathMarkupSchema = z.enum(LATEXDIFF_MATH_MARKUP_VALUES);
export type LatexdiffMathMarkup = z.infer<typeof LatexdiffMathMarkupSchema>;

export const LatexConfigValuesSchema = z.object({
  workflowAutoCompile: z.boolean().optional(),
  workflowAutoCompileTimeoutMs: z
    .int()
    .min(LATEX_CONFIG_RANGES.workflowAutoCompileTimeoutMs.min)
    .optional(),
  latexdiffBetweenRounds: z.boolean().optional(),
  latexdiffTimeoutMs: z
    .int()
    .min(LATEX_CONFIG_RANGES.latexdiffTimeoutMs.min)
    .max(LATEX_CONFIG_RANGES.latexdiffTimeoutMs.max!)
    .optional(),
  latexdiffMathMarkup: LatexdiffMathMarkupSchema.optional(),
  latexFormatter: LatexFormatterSchema.optional(),
});
export type LatexConfigValues = z.infer<typeof LatexConfigValuesSchema>;

/** Outbound: backend → frontend current LaTeX/compile/diff config values. */
export const UpdateLatexConfigValuesMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_CONFIG_VALUES),
  values: LatexConfigValuesSchema,
});
export type UpdateLatexConfigValuesMessage = z.infer<
  typeof UpdateLatexConfigValuesMessageSchema
>;

/** Outbound: backend → frontend inline criticism toggle state */
export const UpdateInlineCriticismEnabledMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_INLINE_CRITICISM_ENABLED),
  enabled: z.boolean(),
});
export type UpdateInlineCriticismEnabledMessage = z.infer<
  typeof UpdateInlineCriticismEnabledMessageSchema
>;

// ============================================================
// Inbound message schemas (frontend → backend)
// ============================================================

// Memory, History, and Profile inbound schemas are imported from their
// respective modules (memoryViewMessages, historyViewMessages, profileViewMessages)
// to avoid duplicating definitions. The command literal strings are identical.

// Provider key inbound messages (settings-only)
// Keep the outer optional: callers may omit apiKey so the host can prompt.
const SubmittedApiKeySchema = z
  .preprocess(
    (value) =>
      typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.string().trim().min(1).optional(),
  )
  .optional();

const SetProviderKeyMessageSchema = z.object({
  command: z.literal(CMD.SET_PROVIDER_KEY),
  provider: z.string().min(1),
  apiKey: SubmittedApiKeySchema,
});

const RemoveProviderKeyMessageSchema = z.object({
  command: z.literal(CMD.REMOVE_PROVIDER_KEY),
  provider: z.string().min(1),
});

const OpenProviderKeyUrlMessageSchema = z.object({
  command: z.literal(CMD.OPEN_PROVIDER_KEY_URL),
  provider: z.string().min(1),
});

const SetProviderStreamingMessageSchema = z.object({
  command: z.literal(CMD.SET_PROVIDER_STREAMING),
  provider: z.string().min(1),
  enabled: z.boolean(),
});

const SetProviderEndpointMessageSchema = z.object({
  command: z.literal(CMD.SET_PROVIDER_ENDPOINT),
  provider: z.string().min(1),
  endpoint: z.string(),
});

const SetGlobalStreamingMessageSchema = z.object({
  command: z.literal(CMD.SET_GLOBAL_STREAMING),
  enabled: z.boolean(),
});

const SetProviderVscodeSettingMessageSchema = z.object({
  command: z.literal(CMD.SET_PROVIDER_VSCODE_SETTING),
  key: z.string().min(1),
  value: z.union([z.boolean(), z.number()]),
});

const OpenExternalUrlMessageSchema = z.object({
  command: z.literal(CMD.OPEN_EXTERNAL_URL),
  url: z.url(),
});

// Model selection inbound messages
const GetModelSelectionMessageSchema = commandOnly(CMD.GET_MODEL_SELECTION);

const SetModelEnabledMessageSchema = z.object({
  command: z.literal(CMD.SET_MODEL_ENABLED),
  modelName: z.string().min(1),
  enabled: z.boolean(),
});

const SetHelperModelMessageSchema = z.object({
  command: z.literal(CMD.SET_HELPER_MODEL),
  modelName: z.string().min(1),
});

const SetModelReasoningLevelMessageSchema = z.object({
  command: z.literal(CMD.SET_MODEL_REASONING_LEVEL),
  modelName: z.string().min(1),
  /** The reasoning level to set, or undefined/null to reset to model default. */
  level: ReasoningLevelSchema.nullable(),
});

const SetPreferShortModelNamesMessageSchema = z.object({
  command: z.literal(CMD.SET_PREFER_SHORT_MODEL_NAMES),
  enabled: z.boolean(),
});

// Agent selection inbound messages
const GetAgentSelectionMessageSchema = commandOnly(CMD.GET_AGENT_SELECTION);

const OpenAgentYamlMessageSchema = z.object({
  command: z.literal(CMD.OPEN_AGENT_YAML),
  agentName: z.string().min(1),
  agentSource: AgentSourceSchema,
});

const SetAgentEnabledMessageSchema = z.object({
  command: z.literal(CMD.SET_AGENT_ENABLED),
  agentName: z.string().min(1),
  agentSource: AgentSourceSchema,
  category: AgentCategorySchema,
  enabled: z.boolean(),
});

const SetAllAgentsEnabledMessageSchema = z.object({
  command: z.literal(CMD.SET_ALL_AGENTS_ENABLED),
  category: AgentCategorySchema,
  source: AgentSourceSchema,
  enabled: z.boolean(),
});

const OpenAgentFolderMessageSchema = z.object({
  command: z.literal(CMD.OPEN_AGENT_FOLDER),
  folderType: z.literal('custom'),
});

const CreateAgentMessageSchema = z.object({
  command: z.literal(CMD.CREATE_AGENT),
  category: AgentCategorySchema,
  mode: z.enum(['ai', 'template']).prefault('ai'),
});

const CustomizeAgentMessageSchema = z.object({
  command: z.literal(CMD.CUSTOMIZE_AGENT),
  agentName: z.string().min(1),
  agentSource: AgentSourceSchema,
});

const DeleteCustomAgentMessageSchema = z.object({
  command: z.literal(CMD.DELETE_CUSTOM_AGENT),
  agentName: z.string().min(1),
});

const RevealAgentFileMessageSchema = z.object({
  command: z.literal(CMD.REVEAL_AGENT_FILE),
  agentName: z.string().min(1),
  agentSource: AgentSourceSchema,
});

const ViewRemoteAgentPromptMessageSchema = z.object({
  command: z.literal(CMD.VIEW_REMOTE_AGENT_PROMPT),
  agentName: z.string().min(1),
});

// Custom agent directory inbound messages
const GetCustomAgentDirMessageSchema = commandOnly(CMD.GET_CUSTOM_AGENT_DIR);
const SetCustomAgentDirMessageSchema = commandOnly(CMD.SET_CUSTOM_AGENT_DIR);
const ResetCustomAgentDirMessageSchema = commandOnly(
  CMD.RESET_CUSTOM_AGENT_DIR,
);

// Super YOLO inbound messages
const GetSuperYoloEnabledMessageSchema = commandOnly(
  CMD.GET_SUPER_YOLO_ENABLED,
);

const SetSuperYoloEnabledMessageSchema = z.object({
  command: z.literal(CMD.SET_SUPER_YOLO_ENABLED),
  enabled: z.boolean(),
});

// Allow orchestrator kill inbound message
const SetAllowOrchestratorKillMessageSchema = z.object({
  command: z.literal(CMD.SET_ALLOW_ORCHESTRATOR_KILL),
  enabled: z.boolean(),
});

const SetDetachSubagentsOnStopMessageSchema = z.object({
  command: z.literal(CMD.SET_DETACH_SUBAGENTS_ON_STOP),
  enabled: z.boolean(),
});

const SetNestedDelegationMaxDepthMessageSchema = z.object({
  command: z.literal(CMD.SET_NESTED_DELEGATION_MAX_DEPTH),
  value: z
    .int()
    .min(NESTED_DELEGATION_DEPTH_RANGE.min)
    .max(NESTED_DELEGATION_DEPTH_RANGE.max),
});

// Agent team inbound messages
const GetAgentModePresetsMessageSchema = commandOnly(
  CMD.GET_AGENT_MODE_PRESETS,
);

const ApplyAgentModePresetMessageSchema = z.object({
  command: z.literal(CMD.APPLY_AGENT_MODE_PRESET),
  presetId: z.string().min(1),
});

const SaveAgentModePresetMessageSchema = commandOnly(
  CMD.SAVE_AGENT_MODE_PRESET,
);

const DeleteAgentModePresetMessageSchema = z.object({
  command: z.literal(CMD.DELETE_AGENT_MODE_PRESET),
  presetId: z.string().min(1),
});

// Tool dashboard inbound messages
const GetToolDashboardDataMessageSchema = commandOnly(
  CMD.GET_TOOL_DASHBOARD_DATA,
);

const OpenToolInstallUrlMessageSchema = z.object({
  command: z.literal(CMD.OPEN_TOOL_INSTALL_URL),
  url: z.url(),
});

const InstallToolExtensionMessageSchema = z.object({
  command: z.literal(CMD.INSTALL_TOOL_EXTENSION),
  extensionId: z.string().min(1),
});

const RecheckToolStatusMessageSchema = commandOnly(CMD.RECHECK_TOOL_STATUS);

const ToggleToolMessageSchema = z.object({
  command: z.literal(CMD.TOGGLE_TOOL),
  toolId: z.string().min(1),
  enabled: z.boolean(),
});

const RunToolCommandMessageSchema = z.object({
  command: z.literal(CMD.RUN_TOOL_COMMAND),
  toolId: z.string().min(1),
  kind: z.enum(['install', 'auth']),
});
export type ToolCommandKind = z.infer<
  typeof RunToolCommandMessageSchema
>['kind'];

// Git author settings inbound messages
const GetGitAuthorSettingsMessageSchema = commandOnly(
  CMD.GET_GIT_AUTHOR_SETTINGS,
);

const SetGitMarkCommitsMessageSchema = z.object({
  command: z.literal(CMD.SET_GIT_MARK_COMMITS),
  enabled: z.boolean(),
});

const SetGitAuthorNameMessageSchema = z.object({
  command: z.literal(CMD.SET_GIT_AUTHOR_NAME),
  name: z.string(),
});

const SetGitAuthorEmailMessageSchema = z.object({
  command: z.literal(CMD.SET_GIT_AUTHOR_EMAIL),
  email: z.string(),
});

const SetGitWorktreeSupportMessageSchema = z.object({
  command: z.literal(CMD.SET_GIT_WORKTREE_SUPPORT),
  enabled: z.boolean(),
});

// GitHub token messages (for PR subscription tool)
const GetGitHubTokenStatusMessageSchema = commandOnly(
  CMD.GET_GITHUB_TOKEN_STATUS,
);

const SetGitHubTokenMessageSchema = commandOnly(CMD.SET_GITHUB_TOKEN);

const RemoveGitHubTokenMessageSchema = commandOnly(CMD.REMOVE_GITHUB_TOKEN);

const OpenGitHubTokenUrlMessageSchema = commandOnly(CMD.OPEN_GITHUB_TOKEN_URL);

const GetDesktopCrashReportingMessageSchema = commandOnly(
  CMD.GET_DESKTOP_CRASH_REPORTING,
);
const SetDesktopCrashReportingEnabledMessageSchema = z.object({
  command: z.literal(CMD.SET_DESKTOP_CRASH_REPORTING_ENABLED),
  enabled: z.boolean(),
});
const SetDesktopCrashReportingDsnMessageSchema = commandOnly(
  CMD.SET_DESKTOP_CRASH_REPORTING_DSN,
);

const GetPRSubscriptionsMessageSchema = commandOnly(CMD.GET_PR_SUBSCRIPTIONS);

const UnsubscribePRMessageSchema = z.object({
  command: z.literal(CMD.UNSUBSCRIBE_PR),
  key: z.string().min(1),
});

const OpenPRSubscriptionStreamMessageSchema = z.object({
  command: z.literal(CMD.OPEN_PR_SUBSCRIPTION_STREAM),
  streamId: StreamTabIdSchema,
});

// LaTeX settings inbound messages
const GetLatexSettingsStatusMessageSchema = commandOnly(
  CMD.GET_LATEX_SETTINGS_STATUS,
);
const ApplyLatexSettingsMessageSchema = z.object({
  command: z.literal(CMD.APPLY_LATEX_SETTINGS),
  field: z.enum(['outDir', 'autoRevealExclude']).optional(),
  reset: z.boolean().optional(),
});
const InstallLatexWorkshopMessageSchema = commandOnly(
  CMD.INSTALL_LATEX_WORKSHOP,
);
const RunInstallCommandMessageSchema = z.object({
  command: z.literal(CMD.RUN_INSTALL_COMMAND),
  installCommand: z.string().min(1),
});

// LaTeX/compile/diff config (storage-backed)
const GetLatexConfigValuesMessageSchema = commandOnly(
  CMD.GET_LATEX_CONFIG_VALUES,
);
/**
 * Single-property write — frontend sends one value at a time. Surface a flat
 * shape (single outer branch keyed on `command`) so it composes into the
 * outer `SettingsViewInboundMessageSchema` discriminatedUnion('command', ...)
 * without producing duplicate command discriminators (which would crash the
 * whole inbound dispatcher at parse time, taking down every Settings view
 * interaction). Per-field value validation happens in the backend handler
 * using `LatexConfigValuesSchema.shape[field]`.
 */
// Use the canonical field list from latex.ts as the schema source so it can
// never drift from `LATEX_FIELD_TO_KEY`. The runtime tuple cast preserves the
// literal types so `LatexConfigField` (re-exported above) stays as the same
// union of string literals consumers already rely on.
const LatexConfigFieldSchema = z.enum(
  LATEX_CONFIG_FIELDS as readonly [
    (typeof LATEX_CONFIG_FIELDS)[number],
    ...(typeof LATEX_CONFIG_FIELDS)[number][],
  ],
);

const SetLatexConfigValueMessageSchema = z.object({
  command: z.literal(CMD.SET_LATEX_CONFIG_VALUE),
  field: LatexConfigFieldSchema,
  // Loose at the schema level — the handler validates per-field via
  // LatexConfigValuesSchema.shape[field] before writing to workspace state.
  // `undefined` clears the key (returns to documented default).
  value: z.union([z.boolean(), z.number(), z.string(), z.null()]).optional(),
});

// Experimental settings inbound messages
const GetInlineCriticismEnabledMessageSchema = commandOnly(
  CMD.GET_INLINE_CRITICISM_ENABLED,
);
const SetInlineCriticismEnabledMessageSchema = z.object({
  command: z.literal(CMD.SET_INLINE_CRITICISM_ENABLED),
  enabled: z.boolean(),
});

// Approval settings inbound messages
const GetApprovalSettingsMessageSchema = commandOnly(CMD.GET_APPROVAL_SETTINGS);
const SetBashApprovalEnabledMessageSchema = z.object({
  command: z.literal(CMD.SET_BASH_APPROVAL_ENABLED),
  enabled: z.boolean(),
});
const SetCodexSandboxModeMessageSchema = z.object({
  command: z.literal(CMD.SET_CODEX_SANDBOX_MODE),
  mode: CodexSandboxModeSchema,
});
const SetCodexReasoningEffortMessageSchema = z.object({
  command: z.literal(CMD.SET_CODEX_REASONING_EFFORT),
  effort: CodexReasoningEffortSchema,
});
const SetCodexApprovalPolicyMessageSchema = z.object({
  command: z.literal(CMD.SET_CODEX_APPROVAL_POLICY),
  policy: CodexApprovalPolicySchema,
});

// Navigation inbound messages
const OpenVscodeSettingsMessageSchema = commandOnly(CMD.OPEN_VSCODE_SETTINGS);

// ============================================================
// Discriminated union of all inbound messages
// ============================================================

export const SettingsViewInboundMessageSchema = z.discriminatedUnion(
  'command',
  [
    // Lifecycle
    WebviewReadyMessageSchema,
    // Navigation messages
    OpenVscodeSettingsMessageSchema,
    // Tool dashboard messages
    GetToolDashboardDataMessageSchema,
    OpenToolInstallUrlMessageSchema,
    InstallToolExtensionMessageSchema,
    RecheckToolStatusMessageSchema,
    ToggleToolMessageSchema,
    RunToolCommandMessageSchema,
    // LaTeX settings messages
    GetLatexSettingsStatusMessageSchema,
    ApplyLatexSettingsMessageSchema,
    InstallLatexWorkshopMessageSchema,
    RunInstallCommandMessageSchema,
    GetLatexConfigValuesMessageSchema,
    SetLatexConfigValueMessageSchema,
    GetInlineCriticismEnabledMessageSchema,
    SetInlineCriticismEnabledMessageSchema,
    // Memory messages
    GetMemoryDataMessageSchema,
    GetMemoryPreviewMessageSchema,
    OpenMemoryFileMessageSchema,
    OpenMemoryFolderMessageSchema,
    DeleteMemoryMessageSchema,
    GetMemoryEnabledMessageSchema,
    SetMemoryEnabledMessageSchema,
    PinMemoryMessageSchema,
    UnpinMemoryMessageSchema,
    // History messages
    GetHistoryDataMessageSchema,
    RerunAgentMessageSchema,
    RestoreAgentMessageSchema,
    DeleteAgentMessageSchema,
    ClearHistoryMessageSchema,
    ExportChatMdMessageSchema,
    ExportChatTexMessageSchema,
    // Profile messages
    GetProfileDataMessageSchema,
    SelectAgentInboundMessageSchema,
    SignInMessageSchema,
    SignOutMessageSchema,
    SetApiAccessModeInboundMessageSchema,
    SetProviderKeyMessageSchema,
    RemoveProviderKeyMessageSchema,
    OpenProviderKeyUrlMessageSchema,
    SetProviderStreamingMessageSchema,
    SetProviderEndpointMessageSchema,
    SetGlobalStreamingMessageSchema,
    SetProviderVscodeSettingMessageSchema,
    OpenExternalUrlMessageSchema,
    // Model selection messages
    GetModelSelectionMessageSchema,
    SetModelEnabledMessageSchema,
    SetHelperModelMessageSchema,
    SetModelReasoningLevelMessageSchema,
    SetPreferShortModelNamesMessageSchema,
    // Agent selection messages
    GetAgentSelectionMessageSchema,
    OpenAgentYamlMessageSchema,
    SetAgentEnabledMessageSchema,
    SetAllAgentsEnabledMessageSchema,
    OpenAgentFolderMessageSchema,
    CreateAgentMessageSchema,
    CustomizeAgentMessageSchema,
    DeleteCustomAgentMessageSchema,
    RevealAgentFileMessageSchema,
    ViewRemoteAgentPromptMessageSchema,
    // Custom agent directory messages
    GetCustomAgentDirMessageSchema,
    SetCustomAgentDirMessageSchema,
    ResetCustomAgentDirMessageSchema,
    // Super YOLO messages
    GetSuperYoloEnabledMessageSchema,
    SetSuperYoloEnabledMessageSchema,
    SetAllowOrchestratorKillMessageSchema,
    SetDetachSubagentsOnStopMessageSchema,
    SetNestedDelegationMaxDepthMessageSchema,
    // Git author settings messages
    GetGitAuthorSettingsMessageSchema,
    SetGitMarkCommitsMessageSchema,
    SetGitAuthorNameMessageSchema,
    SetGitAuthorEmailMessageSchema,
    SetGitWorktreeSupportMessageSchema,
    // GitHub token messages
    GetGitHubTokenStatusMessageSchema,
    SetGitHubTokenMessageSchema,
    RemoveGitHubTokenMessageSchema,
    OpenGitHubTokenUrlMessageSchema,
    GetDesktopCrashReportingMessageSchema,
    SetDesktopCrashReportingEnabledMessageSchema,
    SetDesktopCrashReportingDsnMessageSchema,
    GetPRSubscriptionsMessageSchema,
    UnsubscribePRMessageSchema,
    OpenPRSubscriptionStreamMessageSchema,
    // Approval settings messages
    GetApprovalSettingsMessageSchema,
    SetBashApprovalEnabledMessageSchema,
    SetCodexSandboxModeMessageSchema,
    SetCodexReasoningEffortMessageSchema,
    SetCodexApprovalPolicyMessageSchema,
    // Agent team messages
    GetAgentModePresetsMessageSchema,
    ApplyAgentModePresetMessageSchema,
    SaveAgentModePresetMessageSchema,
    DeleteAgentModePresetMessageSchema,
  ],
);

export type SettingsViewInboundMessage = z.infer<
  typeof SettingsViewInboundMessageSchema
>;

/** Type helper for extracting a specific inbound message by command. */
export type SettingsMessageFor<
  C extends SettingsViewInboundMessage['command'],
> = Extract<SettingsViewInboundMessage, { command: C }>;

// ============================================================
// Type-safe handler registry and dispatcher
// ============================================================

export type SettingsViewInboundHandlerRegistry =
  HandlerRegistry<SettingsViewInboundMessage>;

export const dispatchSettingsViewInbound = createDispatcher(
  SettingsViewInboundMessageSchema,
);
