/**
 * SettingsView data schemas and outbound (backend → webview) message schemas:
 * tab order, agent/model selection, tool dashboard, approval, git, LaTeX, and
 * goal data, plus the outbound discriminated union and dispatcher.
 *
 * Inbound (webview → backend) message schemas live in `./inbound`; the public
 * entry barrel (`../settingsViewMessages`) re-exports both.
 */
import { z } from 'zod';

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import {
  LATEX_CONFIG_RANGES,
  LATEX_FORMATTER_VALUES,
  LATEXDIFF_MATH_MARKUP_VALUES,
} from '@shared/constants/latex';
import {
  createDispatcher,
  type HandlerRegistry,
} from '@shared/utils/dispatcher';
import { GoalSchema } from '../goal';

import {
  AgentCategorySchema,
  AgentMetadataBaseSchema,
  AgentSourceSchema,
} from '../agent';
import { AgentModePresetSchema } from '../agentPresets';
import { AgentSkillsEnabledSchema } from '../agentSkills';
import { ModelAvailabilityFieldsSchema } from '../mainView';
import {
  ChatGptSubscriptionStatusSchema,
  type ChatGptSubscriptionStatus,
} from '../modelAccess';
import {
  NumberVscodeSettingSchema,
  UpdateProfileMessageSchema,
} from '../profileViewMessages';
import { StreamTabIdSchema } from '../identifiers';
import {
  UpdateMemoryEnabledMessageSchema,
  UpdateMemoryMessageSchema,
  UpdateMemoryPreviewMessageSchema,
} from '../memoryViewMessages';
import {
  HistoryClearedMessageSchema,
  UpdateHistoryMessageSchema,
} from '../historyViewMessages';
import {
  ClaudeAgentEffortSchema,
  ClaudeAgentModelSchema,
  ClaudeAgentPermissionModeSchema,
  CodexApprovalPolicySchema,
  CodexReasoningEffortSchema,
  CodexSandboxModeSchema,
} from '../agentCliSettings';
export type {
  ClaudeAgentEffort,
  ClaudeAgentModel,
  ClaudeAgentPermissionMode,
  CodexApprovalPolicy,
  CodexReasoningEffort,
  CodexSandboxMode,
} from '../agentCliSettings';

/** Tab name order - single source of truth for tab indices */
export const SETTINGS_TAB_ORDER = [
  'MEMORY',
  'HISTORY',
  'MODELS',
  'AGENTS',
  'MULTI_AGENT',
  'TOOLS',
  'AI_AGENTS',
  'GIT',
  'LATEX',
  'GOAL',
] as const;

export type SettingsTabName = (typeof SETTINGS_TAB_ORDER)[number];

function toSettingsTabPanelName(name: SettingsTabName): string {
  return name.toLowerCase().replaceAll('_', '-');
}

export const SETTINGS_TAB_PANEL_BY_NAME = Object.fromEntries(
  SETTINGS_TAB_ORDER.map((name) => [name, toSettingsTabPanelName(name)]),
) as Record<SettingsTabName, string>;

export const SETTINGS_TAB_PANEL_NAMES = SETTINGS_TAB_ORDER.map(
  (name) => SETTINGS_TAB_PANEL_BY_NAME[name],
);

/** Tab indices derived from ordered array */
export const SETTINGS_TAB = Object.fromEntries(
  SETTINGS_TAB_ORDER.map((name, index) => [name, index]),
) as Record<SettingsTabName, number>;

export type SettingsTab = (typeof SETTINGS_TAB)[keyof typeof SETTINGS_TAB];

/** Outbound schema to switch tabs */
const SetTabMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.SET_TAB),
  tabIndex: z
    .int()
    .min(0)
    .max(SETTINGS_TAB_ORDER.length - 1),
  agentSubTab: AgentCategorySchema.optional(),
});

// ============================================================
// Agent selection data schema
// ============================================================

/**
 * Agent selection data for the settings view.
 * Extends AgentMetadataBaseSchema (name, category, description) with
 * settings-specific fields for UI state.
 */
const AgentSelectionItemSchema = AgentMetadataBaseSchema.extend({
  source: AgentSourceSchema,
  hasPath: z.boolean(),
  filePath: z.string().optional(),
  tools: z.array(z.string()).optional(),
  enabled: z.boolean(),
});
export type AgentSelectionItem = z.infer<typeof AgentSelectionItemSchema>;

/** Outbound: backend → frontend agent selection data */
const UpdateAgentSelectionMessageSchema = z.object({
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

/** Reasoning effort levels that a user can select (low → high tiers). */
export const ReasoningLevelSchema = z.enum([
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);
export type ReasoningLevel = z.infer<typeof ReasoningLevelSchema>;
export const REASONING_LEVEL_LABELS: Record<ReasoningLevel, string> = {
  none: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
};
export const REASONING_LEVEL_OPTIONS: readonly {
  readonly value: ReasoningLevel;
  readonly label: string;
}[] = ReasoningLevelSchema.options.map((value) => ({
  value,
  label: REASONING_LEVEL_LABELS[value],
}));

const ModelSelectionItemSchema = z.object({
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
  // Resolved once by computeModelOptionsData and carried verbatim so the
  // Models tab renders availability without re-deriving it at render time.
  ...ModelAvailabilityFieldsSchema.shape,
});
export type ModelSelectionItem = z.infer<typeof ModelSelectionItemSchema>;

/** Outbound: backend → frontend model selection data */
const UpdateModelSelectionMessageSchema = z.object({
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
const UpdateCustomAgentDirMessageSchema = z.object({
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
const UpdateSuperYoloEnabledMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_SUPER_YOLO_ENABLED),
  enabled: z.boolean(),
  reliabilitySettings: z.array(NumberVscodeSettingSchema).prefault([]),
  allowOrchestratorKill: z.boolean().prefault(true),
  detachSubagentsOnStop: z.boolean().prefault(false),
});
export type UpdateSuperYoloEnabledMessage = z.infer<
  typeof UpdateSuperYoloEnabledMessageSchema
>;

// ============================================================
// Agent team data schema
// ============================================================

/** Outbound: backend → frontend agent teams (built-in + custom) */
const UpdateAgentModePresetsMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_MODE_PRESETS),
  customPresets: z.array(AgentModePresetSchema),
  /**
   * Agent names that can lead a team (carry delegation tools), computed from
   * the agent registry so preset cards badge orchestrators by capability
   * instead of guessing from the agent's name.
   */
  orchestratorAgents: z.array(z.string()).prefault([]),
});
export type UpdateAgentModePresetsMessage = z.infer<
  typeof UpdateAgentModePresetsMessageSchema
>;

// ============================================================
// Tool dashboard data schemas
// ============================================================

/** Status of a tool dependency */
const ToolStatusSchema = z.enum([
  'available',
  'not-found',
  'unknown',
  'coming-soon',
]);
export type ToolStatus = z.infer<typeof ToolStatusSchema>;

/** Category for grouping tools in the dashboard */
const ToolCategorySchema = z.enum([
  'file',
  'latex',
  'academic',
  'web',
  'computation',
  'lean',
  'workflow',
  'system',
  'ai-agents',
]);
export type ToolCategory = z.infer<typeof ToolCategorySchema>;

/** Individual tool within a group — carries an optional description for tooltips. */
const ToolInfoSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
});
export type ToolInfo = z.infer<typeof ToolInfoSchema>;

/** Single tool entry in the dashboard */
const ToolDashboardItemSchema = z.object({
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
const UpdateToolDashboardMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD),
  items: z.array(ToolDashboardItemSchema),
});

// ============================================================
// Approval settings data schema
// ============================================================

/** Outbound: backend → frontend approval settings */
const UpdateApprovalSettingsMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_APPROVAL_SETTINGS),
  bashApprovalEnabled: z.boolean(),
  codexSandboxMode: CodexSandboxModeSchema,
  codexReasoningEffort: CodexReasoningEffortSchema,
  codexApprovalPolicy: CodexApprovalPolicySchema,
  claudeAgentModel: ClaudeAgentModelSchema,
  claudeAgentPermissionMode: ClaudeAgentPermissionModeSchema,
  claudeAgentEffort: ClaudeAgentEffortSchema,
});
export type UpdateApprovalSettingsMessage = z.infer<
  typeof UpdateApprovalSettingsMessageSchema
>;

/** Outbound: backend → frontend agent skill-catalog setting. */
const UpdateAgentSkillsSettingsMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_SKILLS_SETTINGS),
  enabled: AgentSkillsEnabledSchema,
});
export type UpdateAgentSkillsSettingsMessage = z.infer<
  typeof UpdateAgentSkillsSettingsMessageSchema
>;

// ============================================================
// Git author settings data schema
// ============================================================

/** Outbound: backend → frontend git author settings */
const UpdateGitAuthorSettingsMessageSchema = z.object({
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
const UpdateGitHubTokenStatusMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_GITHUB_TOKEN_STATUS),
  /** 'secret' = stored in SecretStorage; 'env' = GITHUB_TOKEN/GH_TOKEN env var; 'none' = missing. */
  status: z.enum(['secret', 'env', 'none']),
});

/** Outbound: backend → frontend ChatGPT-subscription sign-in status. */
export type ChatGptAuthStatus = ChatGptSubscriptionStatus;

const UpdateChatGptAuthStatusMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_CHATGPT_AUTH_STATUS),
  status: ChatGptSubscriptionStatusSchema,
});
export type UpdateChatGptAuthStatusMessage = z.infer<
  typeof UpdateChatGptAuthStatusMessageSchema
>;

/** Outbound: backend → frontend desktop crash reporting status. */
const UpdateDesktopCrashReportingMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_DESKTOP_CRASH_REPORTING),
  enabled: z.boolean(),
  configured: z.boolean(),
});

const PRSubscriptionOwnerSchema = z.object({
  streamId: StreamTabIdSchema,
  label: z.string(),
});

const PRSubscriptionEntrySchema = z.object({
  key: z.string().min(1),
  owners: z.array(PRSubscriptionOwnerSchema),
});
export type PRSubscriptionEntry = z.infer<typeof PRSubscriptionEntrySchema>;

/** Outbound: backend → frontend active PR subscriptions. */
const UpdatePRSubscriptionsMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_PR_SUBSCRIPTIONS),
  subscriptions: z.array(PRSubscriptionEntrySchema),
});

// ============================================================
// LaTeX settings data schemas
// ============================================================

/** Status of each recommended LaTeX-related VS Code setting. */
const LatexSettingsStatusSchema = z.object({
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
const UpdateLatexSettingsStatusMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_SETTINGS_STATUS),
  settings: LatexSettingsStatusSchema,
});

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
const LatexFormatterSchema = z.enum(LATEX_FORMATTER_VALUES);

const LatexdiffMathMarkupSchema = z.enum(LATEXDIFF_MATH_MARKUP_VALUES);

export const LatexConfigValuesSchema = z.object({
  workflowAutoCompile: z.boolean().optional(),
  workflowAutoCompileTimeoutMs: z
    .int()
    .min(LATEX_CONFIG_RANGES.workflowAutoCompileTimeoutMs.min)
    .optional(),
  workflowAutoOpenPdf: z.boolean().optional(),
  workflowRejectOnCompileFailure: z.boolean().optional(),
  latexdiffBetweenRounds: z.boolean().optional(),
  latexdiffTimeoutMs: z
    .int()
    .min(LATEX_CONFIG_RANGES.latexdiffTimeoutMs.min)
    .max(LATEX_CONFIG_RANGES.latexdiffTimeoutMs.max!)
    .optional(),
  latexdiffMathMarkup: LatexdiffMathMarkupSchema.optional(),
  latexdiffChangesOnly: z.boolean().optional(),
  latexFormatter: LatexFormatterSchema.optional(),
});
export type LatexConfigValues = z.infer<typeof LatexConfigValuesSchema>;

/** Outbound: backend → frontend current LaTeX/compile/diff config values. */
const UpdateLatexConfigValuesMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_CONFIG_VALUES),
  values: LatexConfigValuesSchema,
});
export type UpdateLatexConfigValuesMessage = z.infer<
  typeof UpdateLatexConfigValuesMessageSchema
>;

/** Outbound: backend → frontend inline criticism toggle state */
const UpdateInlineCriticismEnabledMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_INLINE_CRITICISM_ENABLED),
  enabled: z.boolean(),
});

/** Outbound: pushed when the list changes or in response to GET_GOAL_LIST. */
const UpdateGoalListMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_GOAL_LIST),
  items: z.array(GoalSchema),
});

/**
 * Outbound: sent once at webview-ready with the commands this host's inbound
 * registry declares `unsupported(...)` — the derived capability view (see
 * `unsupportedCommands` in `@shared/utils/dispatcher`).
 */
const SetUnsupportedCommandsMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.SET_UNSUPPORTED_COMMANDS),
  commands: z.array(z.string()),
});

// ============================================================
// Outbound messages (extension host → settings webview)
// ============================================================

const SettingsViewOutboundMessageSchema = z.discriminatedUnion('command', [
  SetTabMessageSchema,
  UpdateMemoryMessageSchema,
  UpdateMemoryEnabledMessageSchema,
  UpdateMemoryPreviewMessageSchema,
  UpdateHistoryMessageSchema,
  HistoryClearedMessageSchema,
  UpdateModelSelectionMessageSchema,
  UpdateAgentSelectionMessageSchema,
  UpdateCustomAgentDirMessageSchema,
  UpdateSuperYoloEnabledMessageSchema,
  UpdateAgentModePresetsMessageSchema,
  UpdateApprovalSettingsMessageSchema,
  UpdateAgentSkillsSettingsMessageSchema,
  UpdateToolDashboardMessageSchema,
  UpdateGitAuthorSettingsMessageSchema,
  UpdateGitHubTokenStatusMessageSchema,
  UpdateChatGptAuthStatusMessageSchema,
  UpdateDesktopCrashReportingMessageSchema,
  UpdatePRSubscriptionsMessageSchema,
  UpdateLatexSettingsStatusMessageSchema,
  UpdateLatexConfigValuesMessageSchema,
  UpdateInlineCriticismEnabledMessageSchema,
  UpdateGoalListMessageSchema,
  UpdateProfileMessageSchema,
  SetUnsupportedCommandsMessageSchema,
]);

type SettingsViewOutboundMessage = z.infer<
  typeof SettingsViewOutboundMessageSchema
>;

export type SettingsViewOutboundHandlerRegistry =
  HandlerRegistry<SettingsViewOutboundMessage>;

export const dispatchSettingsViewOutbound = createDispatcher(
  SettingsViewOutboundMessageSchema,
);
