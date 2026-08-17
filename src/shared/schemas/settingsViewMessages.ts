/**
 * Schema definitions for SettingsView messages.
 *
 * Public entry point and single home for the settings-view wire format:
 * combines the messages re-exported from MemoryView and ProfileView with the
 * settings-specific data schemas, the outbound
 * (backend → webview) message union, and the inbound (webview → backend)
 * message union plus their dispatchers.
 */
import { z } from 'zod';

import { SETTINGS_VIEW_CMD, SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { TexraApprovalPolicySchema } from '@shared/approvalPolicy';
import {
  LATEX_CONFIG_RANGES,
  LATEX_FORMATTER_VALUES,
  LATEXDIFF_MATH_MARKUP_VALUES,
} from '@shared/constants/latexConfig';
import {
  NON_REGEX_REPLACEMENT_CATEGORIES,
  REGEX_REPLACEMENT_CATEGORIES,
} from '@shared/constants/replacementCategories';
import {
  createDispatcher,
  type HandlerRegistry,
} from '@shared/utils/dispatcher';
import { GoalSchema } from './goal';

import {
  AgentCategorySchema,
  AgentMetadataBaseSchema,
  AgentSourceSchema,
} from './agent';
import { AgentModePresetSchema } from './agentPresets';
import { AgentSkillsEnabledSchema } from './agentSkills';
import { ChildRunConcurrencyBudgetSchema } from './coreSettings';
import { ModelAvailabilityFieldsSchema } from './mainView/state';
import {
  NumberSettingSchema,
  SetApiAccessModeInboundMessageSchema,
  SignInMessageSchema,
  SignOutMessageSchema,
  UpdateProfileMessageSchema,
} from './profileViewMessages';
import { StreamTabIdSchema } from './identifiers';
import { SubscriptionUsageSnapshotsSchema } from './subscriptionUsage';
import {
  DeleteMemoryMessageSchema,
  GetMemoryDataMessageSchema,
  GetMemoryPreviewMessageSchema,
  OpenMemoryFileMessageSchema,
  OpenMemoryFolderMessageSchema,
  PinMemoryMessageSchema,
  SetMemoryEnabledMessageSchema,
  UnpinMemoryMessageSchema,
  UpdateMemoryEnabledMessageSchema,
  UpdateMemoryMessageSchema,
  UpdateMemoryPreviewMessageSchema,
} from './memoryViewMessages';
import {
  ClaudeAgentEffortSchema,
  ClaudeAgentModelSchema,
  ClaudeAgentPermissionModeSchema,
  CodexApprovalPolicySchema,
  CodexReasoningEffortSchema,
  CodexSandboxModeSchema,
} from './agentCliSettings';
import { commandOnly } from './messageFactories';
import { WebviewReadyMessageSchema } from './commonViewMessages';

// SETTINGS_VIEW_CMD is defined in commands.ts to avoid a circular dependency;
// re-exported here for consumers that expect it from the schema module.
export { SETTINGS_VIEW_CMD } from '@shared/ipc';

// Re-export the Goal type from its shared leaf module so this file (consumed by
// webview frontends) does not pull in GoalTool/GoalStore runtime modules. The
// goal helpers are imported from '@shared/schemas/goal' directly.
export { type Goal } from './goal';

// Re-export the types and values needed by settings consumers from the
// individual view-message modules so the historical settings surface (single
// import site) stays intact. Keep this selective: the schemas themselves are
// deliberately not re-exported here.
export { type MemoryViewItem, type MemoryPreview } from './memoryViewMessages';

export {
  HISTORY_RUN_STATUS_LABEL,
  resolveHistoryRunStatus,
  type HistoryRunStatus,
} from './historyRunStatus';

export {
  API_ACCESS_MODE_OPTIONS,
  DEFAULT_GLOBAL_STREAMING,
  DEFAULT_QUOTA_AUTO_SWITCHED,
  type ApiAccessMode,
  type NumberSetting,
  type ProviderKeyStatus,
  type ProviderSetting,
  type RemoteAgent,
  type SessionProblem,
  type UpdateProfileMessage,
} from './profileViewMessages';

export type {
  ClaudeAgentEffort,
  ClaudeAgentModel,
  ClaudeAgentPermissionMode,
  CodexApprovalPolicy,
  CodexReasoningEffort,
  CodexSandboxMode,
} from './agentCliSettings';

/**
 * Tab name order — single source of truth for tab indices, and a wire format:
 * `SETTINGS_TAB.X` indices travel over IPC (`SET_TAB.tabIndex`) and are
 * hand-copied as integer tables in the desktop e2e specs and the walkthrough
 * capture script.
 *
 * New entries append at the end. Retired internal panels are removed together
 * with their producers and command surfaces so no stale IPC target remains.
 */
export const SETTINGS_TAB_ORDER = [
  'MEMORY',
  'MODELS',
  'AGENTS',
  'MULTI_AGENT',
  'TOOLS',
  'AI_AGENTS',
  'GIT',
  'LATEX',
  'GOAL',
  'ACCOUNT',
  'SHORTCUTS',
  'SUBSCRIPTIONS',
] as const;

export type SettingsTabName = (typeof SETTINGS_TAB_ORDER)[number];

/**
 * Recursive replace used to derive the panel-name literal type from the
 * uppercase tab name (`MULTI_AGENT` → `multi-agent`), mirroring the runtime
 * transformation in `SETTINGS_TAB_PANEL_BY_NAME`.
 */
type ReplaceAll<
  S extends string,
  From extends string,
  To extends string,
> = S extends `${infer Head}${From}${infer Tail}`
  ? `${Head}${To}${ReplaceAll<Tail, From, To>}`
  : S;

/**
 * Webview panel-addressing key for a tab, e.g. `'multi-agent'`. A literal
 * union derived from {@link SettingsTabName}, so an appended tab widens it and
 * exhaustiveness-checked switches (SettingsApp's `renderActivePanel`) become
 * compile errors until they add a case — the panel-name equivalent of the
 * `Record<SettingsTabName, …>` metadata maps.
 */
export type SettingsTabPanelName = ReplaceAll<
  Lowercase<SettingsTabName>,
  '_',
  '-'
>;

export const SETTINGS_TAB_PANEL_BY_NAME = Object.fromEntries(
  SETTINGS_TAB_ORDER.map((name) => [
    name,
    name.toLowerCase().replaceAll('_', '-'),
  ]),
) as Record<SettingsTabName, SettingsTabPanelName>;

export const SETTINGS_TAB_PANEL_NAMES: readonly SettingsTabPanelName[] =
  SETTINGS_TAB_ORDER.map((name) => SETTINGS_TAB_PANEL_BY_NAME[name]);

/** Tab indices derived from ordered array */
export const SETTINGS_TAB = Object.fromEntries(
  SETTINGS_TAB_ORDER.map((name, index) => [name, index]),
) as Record<SettingsTabName, number>;

export type SettingsTab = (typeof SETTINGS_TAB)[keyof typeof SETTINGS_TAB];

/**
 * Presentation-only grouping for the settings top navigation.
 *
 * Deliberately a second, independent layer: `SETTINGS_TAB_ORDER` is the wire
 * format (indices cross IPC and are hand-copied into e2e index tables), so nav
 * grouping and nav display order must never be expressed by reordering it.
 * Groups address panels by `SettingsTabName`, which the nav renders as the
 * panel name (`SETTINGS_TAB_PANEL_BY_NAME`) and `SettingsApp.handleTabShow`
 * resolves back to an index via `SETTINGS_TAB_PANEL_NAMES.indexOf(...)` — so
 * regrouping or reordering the nav changes no index and no `SETTINGS_TAB.X`
 * call site.
 *
 * Every tab must appear in exactly one group, or its panel becomes unreachable
 * from the nav while still being a valid IPC target. `SharedSchemas.vitest.ts`
 * asserts the flattened list is a permutation of `SETTINGS_TAB_ORDER`, so an
 * appended tab cannot ship without being placed here.
 */
export const SETTINGS_TAB_GROUPS = [
  { label: 'Account', tabs: ['ACCOUNT', 'SUBSCRIPTIONS'] },
  { label: 'Models', tabs: ['MODELS'] },
  { label: 'Agents', tabs: ['AGENTS', 'MULTI_AGENT'] },
  { label: 'Capabilities', tabs: ['TOOLS', 'AI_AGENTS', 'LATEX'] },
  { label: 'Workspace', tabs: ['GIT', 'SHORTCUTS'] },
  { label: 'Data & Activity', tabs: ['MEMORY', 'GOAL'] },
] as const satisfies readonly {
  label: string;
  tabs: readonly SettingsTabName[];
}[];

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
  agents: z.record(AgentCategorySchema, z.array(AgentSelectionItemSchema)),
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

/**
 * One discovered Copilot access route, keyed by the canonical base model id
 * (#9635). The Models tab Copilot section renders route status from this list
 * — routes are transports for base models, never picker rows of their own.
 */
const CopilotRouteInfoSchema = z.object({
  name: z.string(),
  label: z.string(),
  access: z.enum(['allowed', 'consent-required', 'unavailable']),
  /** Whether the user has chosen this route for the base model (#9635). */
  preferred: z.boolean(),
});
export type CopilotRouteInfo = z.infer<typeof CopilotRouteInfoSchema>;

/** Outbound: backend → frontend model selection data */
const UpdateModelSelectionMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION),
  models: z.array(ModelSelectionItemSchema),
  helperModel: z.string(),
  /** Whether the user prefers short (unpinned) model names. */
  preferShortModelNames: z.boolean(),
  /** Discovered Copilot routes and their editor-reported access state. */
  copilotModels: z.array(CopilotRouteInfoSchema),
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
// Multi-agent coordination data schema
// ============================================================

/**
 * Outbound: backend → frontend reliability + orchestration settings. The wire
 * literal stays `updateSuperYoloEnabled` for compatibility with shipped
 * webviews, so only the schema and type carry the payload's real name.
 */
const UpdateReliabilityAndOrchestrationMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_SUPER_YOLO_ENABLED),
  reliabilitySettings: z.array(NumberSettingSchema).prefault([]),
  allowOrchestratorKill: z.boolean().prefault(true),
  detachSubagentsOnStop: z.boolean().prefault(false),
  childRunConcurrencyBudget: ChildRunConcurrencyBudgetSchema,
});
export type UpdateReliabilityAndOrchestrationMessage = z.infer<
  typeof UpdateReliabilityAndOrchestrationMessageSchema
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

/**
 * Outbound: backend → frontend snapshot of workspace execution permissions
 * and safety.
 *
 * The command string predates the Codex, Claude, and tool-path controls it now
 * carries. Keep that stable wire discriminator while naming the schema by its
 * actual broader role.
 */
const UpdateApprovalAndSafetySettingsMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_APPROVAL_SETTINGS),
  approvalPolicy: TexraApprovalPolicySchema,
  editApprovalEnabled: z.boolean(),
  bashApprovalEnabled: z.boolean(),
  toolPathProtectionEnabled: z.boolean(),
  codexSandboxMode: CodexSandboxModeSchema,
  codexReasoningEffort: CodexReasoningEffortSchema,
  codexApprovalPolicy: CodexApprovalPolicySchema,
  claudeAgentModel: ClaudeAgentModelSchema,
  claudeAgentPermissionMode: ClaudeAgentPermissionModeSchema,
  claudeAgentEffort: ClaudeAgentEffortSchema,
});
export type UpdateApprovalAndSafetySettingsMessage = z.infer<
  typeof UpdateApprovalAndSafetySettingsMessageSchema
>;

/** Outbound: backend → frontend agent skill-catalog setting. */
const UpdateAgentSkillsSettingsMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_SKILLS_SETTINGS),
  enabled: AgentSkillsEnabledSchema,
});
export type UpdateAgentSkillsSettingsMessage = z.infer<
  typeof UpdateAgentSkillsSettingsMessageSchema
>;

/** Outbound: backend → frontend telemetry preference. */
const UpdateTelemetrySettingsMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_TELEMETRY_SETTINGS),
  enabled: z.boolean(),
});
export type UpdateTelemetrySettingsMessage = z.infer<
  typeof UpdateTelemetrySettingsMessageSchema
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
const ChatGptAuthStatusSchema = z.object({
  signedIn: z.boolean(),
  email: z.string().nullish(),
  accountId: z.string().nullish(),
  preferSubscription: z.boolean(),
});
export type ChatGptAuthStatus = z.infer<typeof ChatGptAuthStatusSchema>;

const UpdateChatGptAuthStatusMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_CHATGPT_AUTH_STATUS),
  status: ChatGptAuthStatusSchema,
});
export type UpdateChatGptAuthStatusMessage = z.infer<
  typeof UpdateChatGptAuthStatusMessageSchema
>;

/** Outbound: backend → frontend Grok-subscription sign-in status. */
const GrokAuthStatusSchema = z.object({
  signedIn: z.boolean(),
  email: z.string().nullish(),
  preferSubscription: z.boolean(),
});
export type GrokAuthStatus = z.infer<typeof GrokAuthStatusSchema>;

const UpdateGrokAuthStatusMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_GROK_AUTH_STATUS),
  status: GrokAuthStatusSchema,
});
export type UpdateGrokAuthStatusMessage = z.infer<
  typeof UpdateGrokAuthStatusMessageSchema
>;

const UpdateSubscriptionUsageMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_SUBSCRIPTION_USAGE),
  snapshots: SubscriptionUsageSnapshotsSchema,
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

const LatexFormatterSchema = z.enum(LATEX_FORMATTER_VALUES);

const LatexdiffMathMarkupSchema = z.enum(LATEXDIFF_MATH_MARKUP_VALUES);

/**
 * LaTeX/compile/diff configuration values, persisted in workspace storage. The
 * frontend tab edits these directly; the backend persists them via
 * `workspaceSM`.
 *
 * Each property is optional so the UI can render either the user-set value
 * (when defined) or the documented default (when undefined). Numeric ranges
 * and enum values come from `@shared/constants/latex` so this schema, the UI,
 * and the runtime readers all stay in lockstep.
 */
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
  wrapCritiqueInAlign: z.boolean().optional(),
  enabledReplacements: z
    .array(z.enum(NON_REGEX_REPLACEMENT_CATEGORIES))
    .optional(),
  enabledReplacementsRegex: z
    .array(z.enum(REGEX_REPLACEMENT_CATEGORIES))
    .optional(),
  customReplacementsRegex: z.record(z.string(), z.string()).optional(),
  customReplacements: z.record(z.string(), z.string()).optional(),
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
  UpdateModelSelectionMessageSchema,
  UpdateAgentSelectionMessageSchema,
  UpdateCustomAgentDirMessageSchema,
  UpdateReliabilityAndOrchestrationMessageSchema,
  UpdateAgentModePresetsMessageSchema,
  UpdateApprovalAndSafetySettingsMessageSchema,
  UpdateAgentSkillsSettingsMessageSchema,
  UpdateTelemetrySettingsMessageSchema,
  UpdateToolDashboardMessageSchema,
  UpdateGitAuthorSettingsMessageSchema,
  UpdateGitHubTokenStatusMessageSchema,
  UpdateChatGptAuthStatusMessageSchema,
  UpdateGrokAuthStatusMessageSchema,
  UpdateSubscriptionUsageMessageSchema,
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

const CMD = SETTINGS_VIEW_CMD;

/** Inbound message carrying a single boolean `enabled` toggle. */
function enabledFlag<T extends string>(command: T) {
  return z.object({ command: z.literal(command), enabled: z.boolean() });
}

// Provider key inbound messages (settings-only)
// Keep the outer optional: callers may omit apiKey so the host can prompt.
const SubmittedApiKeySchema = z
  .string()
  .trim()
  .optional()
  .transform((v) => v || undefined);

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

const SetGlobalStreamingMessageSchema = enabledFlag(CMD.SET_GLOBAL_STREAMING);

const SetProviderSettingMessageSchema = z.object({
  command: z.literal(CMD.SET_PROVIDER_SETTING),
  key: z.string().min(1),
  value: z.union([z.boolean(), z.number()]),
});

const OpenExternalUrlMessageSchema = z.object({
  command: z.literal(CMD.OPEN_EXTERNAL_URL),
  url: z.url(),
});

// Model selection inbound messages
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

const SetPreferShortModelNamesMessageSchema = enabledFlag(
  CMD.SET_PREFER_SHORT_MODEL_NAMES,
);

const RequestModelAccessMessageSchema = z.object({
  command: z.literal(CMD.REQUEST_MODEL_ACCESS),
  modelName: z.string().min(1),
});

const ClearCopilotRouteMessageSchema = z.object({
  command: z.literal(CMD.CLEAR_COPILOT_ROUTE),
  modelName: z.string().min(1),
});

// Agent selection inbound messages
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
const SetCustomAgentDirMessageSchema = commandOnly(CMD.SET_CUSTOM_AGENT_DIR);
const ResetCustomAgentDirMessageSchema = commandOnly(
  CMD.RESET_CUSTOM_AGENT_DIR,
);

// Agent team inbound messages
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

// GitHub token messages (for PR subscription tool)
const GetGitHubTokenStatusMessageSchema = commandOnly(
  CMD.GET_GITHUB_TOKEN_STATUS,
);

const SetGitHubTokenMessageSchema = commandOnly(CMD.SET_GITHUB_TOKEN);

const RemoveGitHubTokenMessageSchema = commandOnly(CMD.REMOVE_GITHUB_TOKEN);

const OpenGitHubTokenUrlMessageSchema = commandOnly(CMD.OPEN_GITHUB_TOKEN_URL);

// ChatGPT subscription (Codex) sign-in messages
const SignInChatGptMessageSchema = commandOnly(CMD.SIGN_IN_CHATGPT);
const SignOutChatGptMessageSchema = commandOnly(CMD.SIGN_OUT_CHATGPT);
const SetChatGptPreferSubscriptionMessageSchema = enabledFlag(
  CMD.SET_CHATGPT_PREFER_SUBSCRIPTION,
);
// Grok (xAI) subscription sign-in messages
const SignInGrokMessageSchema = commandOnly(CMD.SIGN_IN_GROK);
const SignOutGrokMessageSchema = commandOnly(CMD.SIGN_OUT_GROK);
const SetGrokPreferSubscriptionMessageSchema = enabledFlag(
  CMD.SET_GROK_PREFER_SUBSCRIPTION,
);
const GetSubscriptionUsageMessageSchema = z.object({
  command: z.literal(CMD.GET_SUBSCRIPTION_USAGE),
  forceRefresh: z.boolean().optional(),
});
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

// Experimental settings inbound messages
const GetInlineCriticismEnabledMessageSchema = commandOnly(
  CMD.GET_INLINE_CRITICISM_ENABLED,
);
const SetInlineCriticismEnabledMessageSchema = enabledFlag(
  CMD.SET_INLINE_CRITICISM_ENABLED,
);

// Generic catalog-driven setting write. This boundary accepts exactly the
// value shapes used by catalog entries; the selected entry's schema performs
// the narrower per-key validation in the backend handler.
const StateSettingValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  z.record(z.string(), z.string()),
  z.null(),
]);
export type StateSettingValue = z.infer<typeof StateSettingValueSchema>;

const UpdateStateSettingMessageSchema = z.object({
  command: z.literal(CMD.UPDATE_STATE_SETTING),
  key: z.string().min(1),
  value: StateSettingValueSchema.optional(),
});

// Navigation inbound messages
// Settings-tab IPC is read-only: state transitions are owned by the
// agent-side plan tool, not the user. Don't add mutation commands here.
const GetGoalListMessageSchema = commandOnly(CMD.GET_GOAL_LIST);
const RevealGoalStreamMessageSchema = z.object({
  command: z.literal(CMD.REVEAL_GOAL_STREAM),
  streamId: StreamTabIdSchema,
});

// ============================================================
// Discriminated union of all inbound messages
// ============================================================

export const SettingsViewInboundMessageSchema = z.discriminatedUnion(
  'command',
  [
    // Lifecycle
    WebviewReadyMessageSchema,
    // Tool dashboard messages
    OpenToolInstallUrlMessageSchema,
    InstallToolExtensionMessageSchema,
    RecheckToolStatusMessageSchema,
    ToggleToolMessageSchema,
    RunToolCommandMessageSchema,
    // LaTeX settings messages
    ApplyLatexSettingsMessageSchema,
    InstallLatexWorkshopMessageSchema,
    RunInstallCommandMessageSchema,
    GetInlineCriticismEnabledMessageSchema,
    SetInlineCriticismEnabledMessageSchema,
    // Memory messages
    GetMemoryDataMessageSchema,
    GetMemoryPreviewMessageSchema,
    OpenMemoryFileMessageSchema,
    OpenMemoryFolderMessageSchema,
    DeleteMemoryMessageSchema,
    SetMemoryEnabledMessageSchema,
    PinMemoryMessageSchema,
    UnpinMemoryMessageSchema,
    // Profile messages
    SignInMessageSchema,
    SignOutMessageSchema,
    SetApiAccessModeInboundMessageSchema,
    SetProviderKeyMessageSchema,
    RemoveProviderKeyMessageSchema,
    OpenProviderKeyUrlMessageSchema,
    SetProviderStreamingMessageSchema,
    SetProviderEndpointMessageSchema,
    SetGlobalStreamingMessageSchema,
    SetProviderSettingMessageSchema,
    OpenExternalUrlMessageSchema,
    // Model selection messages
    SetModelEnabledMessageSchema,
    SetHelperModelMessageSchema,
    SetModelReasoningLevelMessageSchema,
    SetPreferShortModelNamesMessageSchema,
    RequestModelAccessMessageSchema,
    ClearCopilotRouteMessageSchema,
    // Agent selection messages
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
    SetCustomAgentDirMessageSchema,
    ResetCustomAgentDirMessageSchema,
    // GitHub token messages
    GetGitHubTokenStatusMessageSchema,
    SetGitHubTokenMessageSchema,
    RemoveGitHubTokenMessageSchema,
    OpenGitHubTokenUrlMessageSchema,
    // ChatGPT subscription sign-in messages
    SignInChatGptMessageSchema,
    SignOutChatGptMessageSchema,
    SetChatGptPreferSubscriptionMessageSchema,
    // Grok subscription sign-in messages
    SignInGrokMessageSchema,
    SignOutGrokMessageSchema,
    SetGrokPreferSubscriptionMessageSchema,
    GetSubscriptionUsageMessageSchema,
    GetPRSubscriptionsMessageSchema,
    UnsubscribePRMessageSchema,
    OpenPRSubscriptionStreamMessageSchema,
    // Generic catalog-driven scalar-setting write
    UpdateStateSettingMessageSchema,
    // Agent team messages
    ApplyAgentModePresetMessageSchema,
    SaveAgentModePresetMessageSchema,
    DeleteAgentModePresetMessageSchema,
    // Goal settings-tab messages (read-only)
    GetGoalListMessageSchema,
    RevealGoalStreamMessageSchema,
  ],
);

export type SettingsViewInboundMessage = z.infer<
  typeof SettingsViewInboundMessageSchema
>;

/** Type helper for extracting a specific inbound message by command. */
export type SettingsMessageFor<
  C extends SettingsViewInboundMessage['command'],
> = Extract<SettingsViewInboundMessage, { command: C }>;

export type SettingsViewInboundHandlerRegistry =
  HandlerRegistry<SettingsViewInboundMessage>;

export const dispatchSettingsViewInbound = createDispatcher(
  SettingsViewInboundMessageSchema,
);
