/**
 * Schema definitions for SettingsView messages.
 *
 * Public entry point and single home for the settings-view wire format:
 * combines the messages re-exported from MemoryView and ProfileView with the
 * settings-specific data schemas, the outbound (backend → webview) message
 * union, and the inbound (webview → backend) message union plus their
 * dispatchers.
 */
import { z } from 'zod';
import { ReasoningEffort } from 'llm-zoo';
import { ReasoningEffortSchema } from 'llm-zoo/schemas';

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import {
  createDispatcher,
  type HandlerRegistry,
} from '@shared/utils/dispatcher';
import {
  AgentCategorySchema,
  AgentMetadataBaseSchema,
  AgentModePresetSchema,
  AgentSourceSchema,
  ModelAvailabilityFieldsSchema,
  RunIdSchema,
  SkillDisplayIssueSchema,
  SkillDisplayItemSchema,
  SubscriptionUsageSnapshotsSchema,
  WebviewReadyMessageSchema,
} from '@shared/schemas';
import {
  settingSchemaWithoutPrefault,
  settingsViewSnapshotEntries,
  type SettingsViewSnapshot,
} from '@shared/state/stateSettings';
import {
  SignInMessageSchema,
  SignOutMessageSchema,
  UpdateProfileMessageSchema,
} from './profileViewMessages';
import {
  DeleteMemoryMessageSchema,
  GetMemoryDataMessageSchema,
  GetMemoryPreviewMessageSchema,
  OpenMemoryFileMessageSchema,
  OpenMemoryFolderMessageSchema,
  PinMemoryMessageSchema,
  UnpinMemoryMessageSchema,
  UpdateMemoryMessageSchema,
  UpdateMemoryPreviewMessageSchema,
} from './memoryViewMessages';
import { commandOnly } from './messageFactories';

// Re-export the types and values needed by settings consumers from the
// individual view-message modules so the historical settings surface (single
// import site) stays intact. Keep this selective: the schemas themselves are
// deliberately not re-exported here.
export { type MemoryViewItem, type MemoryPreview } from './memoryViewMessages';

export {
  type ProviderKeyStatus,
  type ProviderSetting,
  type SessionProblem,
  type UpdateProfileMessage,
} from './profileViewMessages';

/**
 * The settings pages in nav order — single source of truth for tab names,
 * spelled the one way they travel: the panel name on the wire (`SET_TAB.tab`)
 * and in every `data-panel` selector. `shortcuts` is desktop-only.
 * Retired internal panels are removed together with their producers and
 * command surfaces so no stale IPC target remains.
 */
export const SETTINGS_TAB_ORDER = [
  'models',
  'agents',
  'tools',
  'latex',
  'memory',
  'general',
  'shortcuts',
] as const;

/**
 * Webview panel-addressing key for a tab, e.g. `'agents'`. A literal union
 * over {@link SETTINGS_TAB_ORDER}, so an appended tab widens it and
 * exhaustiveness-checked switches (SettingsApp's `renderActivePanel`) become
 * compile errors until they add a case — the same effect the
 * `Record<SettingsTabPanelName, …>` metadata maps have.
 */
export type SettingsTabPanelName = (typeof SETTINGS_TAB_ORDER)[number];

/**
 * Each page's sections in sub-tab order; a page with fewer than two shows no
 * second nav row. `vscode` (LaTeX) exists on the extension only.
 */
export const SETTINGS_PAGE_SECTIONS = {
  models: ['keys', 'subscriptions', 'models'],
  agents: ['library', 'teams', 'skills', 'advanced'],
  tools: ['approval', 'tools', 'integrations'],
  latex: ['dependencies', 'compile', 'formatting', 'vscode'],
  memory: [],
  general: ['account', 'git'],
  shortcuts: [],
} as const satisfies Record<SettingsTabPanelName, readonly string[]>;

/** A section of page `P`, e.g. `'teams'` for `'agents'`. */
export type SettingsSectionName<
  P extends SettingsTabPanelName = SettingsTabPanelName,
> = (typeof SETTINGS_PAGE_SECTIONS)[P][number];

/**
 * Where a settings link lands: a page (on its remembered section), or one
 * section of it spelled `page/section`, e.g. `'agents/teams'`.
 */
export type SettingsTarget =
  | SettingsTabPanelName
  | {
      [P in SettingsTabPanelName]: `${P}/${SettingsSectionName<P>}`;
    }[SettingsTabPanelName];

export const SettingsTargetSchema = z.enum(
  SETTINGS_TAB_ORDER.flatMap((page) => [
    page,
    ...SETTINGS_PAGE_SECTIONS[page].map((section) => `${page}/${section}`),
  ]) as [SettingsTarget, ...SettingsTarget[]],
);

/** Outbound schema to switch tabs, addressed by page or `page/section`. */
const SetTabMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.SET_TAB),
  tab: SettingsTargetSchema,
  agentSubTab: AgentCategorySchema.optional(),
});

// ============================================================
// Catalog-derived settings snapshots
// ============================================================

/**
 * The snapshots whose whole payload is a plain list of catalog rows. They all
 * travel under the one `UPDATE_SETTINGS_SNAPSHOT` command, discriminated by
 * `snapshot`.
 *
 * A snapshot absent from this list is one whose payload is not a plain list of
 * catalog rows (`profile`, `models`); those arms still declare their own shape
 * below or in their own module.
 */
const DERIVED_SETTINGS_SNAPSHOTS = [
  'approval',
  'git-author',
  'skills',
  'telemetry',
  'multi-agent',
  'latex',
  'memory',
] as const satisfies readonly SettingsViewSnapshot[];

/** A snapshot whose whole payload is derived from the settings catalog. */
export type DerivedSettingsSnapshot =
  (typeof DERIVED_SETTINGS_SNAPSHOTS)[number];

/**
 * One snapshot's member of the outbound snapshot arm: its name plus one
 * `values` object carrying every catalog row tagged for that snapshot, keyed
 * by its canonical `texra.*` key and validated by the row's own schema.
 *
 * This is the `pickProjection` idiom (`progressView/projectionShape.ts`)
 * applied to settings: an arm reads the one declared shape instead of
 * restating its fields, so a row added to a snapshot reaches the wire, the
 * backend read, and the webview apply step together. Keying by catalog key
 * also matches the inbound generic `UPDATE_STATE_SETTING` `{key, value}`
 * boundary, so both directions address a setting the same way.
 */
function snapshotMessage<S extends DerivedSettingsSnapshot>(snapshot: S) {
  return z.object({
    command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_SETTINGS_SNAPSHOT),
    snapshot: z.literal(snapshot),
    values: z.strictObject(
      Object.fromEntries(
        settingsViewSnapshotEntries(snapshot).map((entry) => [
          entry.key,
          settingSchemaWithoutPrefault(entry),
        ]),
      ),
    ),
  });
}

const [firstDerivedSnapshot, ...otherDerivedSnapshots] =
  DERIVED_SETTINGS_SNAPSHOTS;

/** Outbound: backend → frontend catalog-derived snapshot, keyed by `snapshot`. */
const UpdateSettingsSnapshotMessageSchema = z.discriminatedUnion('snapshot', [
  snapshotMessage(firstDerivedSnapshot),
  ...otherDerivedSnapshots.map(snapshotMessage),
]);

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

/** A custom-agent YAML file the registry found but could not load. */
const AgentScanIssueSchema = z.object({
  path: z.string(),
  message: z.string(),
});
export type AgentScanIssue = z.infer<typeof AgentScanIssueSchema>;

/** Outbound: backend → frontend agent selection data */
const UpdateAgentSelectionMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_SELECTION),
  agents: z.record(AgentCategorySchema, z.array(AgentSelectionItemSchema)),
  customAgentIssues: z.array(AgentScanIssueSchema).prefault([]),
});

// ============================================================
// Model selection data schema
// ============================================================

/**
 * Display labels for llm-zoo's reasoning efforts, written low → high because
 * the picker offers them in that order. The key type keeps the record
 * exhaustive against the registry vocabulary.
 */
export const REASONING_LEVEL_LABELS: Record<ReasoningEffort, string> = {
  [ReasoningEffort.NONE]: 'None',
  [ReasoningEffort.MINIMAL]: 'Minimal',
  [ReasoningEffort.LOW]: 'Low',
  [ReasoningEffort.MEDIUM]: 'Medium',
  [ReasoningEffort.HIGH]: 'High',
  [ReasoningEffort.XHIGH]: 'Extra High',
  [ReasoningEffort.MAX]: 'Max',
};
export const REASONING_LEVEL_OPTIONS: readonly {
  readonly value: ReasoningEffort;
  readonly label: string;
}[] = Object.entries(REASONING_LEVEL_LABELS).map(([value, label]) => ({
  value: value as ReasoningEffort,
  label,
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
  defaultReasoningLevel: ReasoningEffortSchema.optional(),
  /** The user's chosen reasoning level override (undefined = use default). */
  reasoningLevel: ReasoningEffortSchema.optional(),
  /** Exact registry-declared effort vocabulary for this model. */
  supportedReasoningLevels: z.array(ReasoningEffortSchema).optional(),
  /** Whether this model qualifies as a "fast first response" pick (price-based). */
  isFast: z.boolean().optional(),
  /** Whether this model's API pricing earns the premium warning (price-based). */
  isExpensive: z.boolean().optional(),
  // Resolved once by modelOptionsFrom and carried verbatim so the
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
  /**
   * The team the workspace roster currently resolves to, or null when it runs
   * no team. Owned by the roster so a preset card reports the applied team
   * rather than the last one the user clicked.
   */
  activePresetId: z.string().nullable().prefault(null),
});

// ============================================================
// Tool dashboard data schemas
// ============================================================

/** Availability of a tool dependency (not a tool call's `ToolCallStatus`). */
const ToolDependencyStatusSchema = z.enum([
  'available',
  'not-found',
  'unknown',
]);
export type ToolDependencyStatus = z.infer<typeof ToolDependencyStatusSchema>;

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

/** One setup action exposed by a tool dashboard card. */
const ToolInstallActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('guide'), text: z.string().min(1) }),
  z.strictObject({ kind: z.literal('url'), url: z.url() }),
  z.strictObject({
    kind: z.literal('extension'),
    extensionId: z.string().min(1),
  }),
  z.strictObject({ kind: z.literal('command'), command: z.string().min(1) }),
  z.strictObject({ kind: z.literal('auth'), command: z.string().min(1) }),
]);
export type ToolInstallAction = z.infer<typeof ToolInstallActionSchema>;

/** One dashboard card; `settings` are its inline rows as [catalog key, label]. */
const ToolDashboardItemSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  category: ToolCategorySchema,
  description: z.string(),
  tools: z.array(ToolInfoSchema),
  status: ToolDependencyStatusSchema,
  requiresSetup: z.boolean(),
  statusLabel: z.string().optional(),
  installActions: z.array(ToolInstallActionSchema),
  configNotes: z.string().optional(),
  statusDetail: z.string().optional(),
  authNote: z.string().optional(),
  toggleable: z.boolean().optional(),
  enabled: z.boolean().optional(),
  settings: z.array(z.tuple([z.string(), z.string()])).optional(),
});
export type ToolDashboardItem = z.infer<typeof ToolDashboardItemSchema>;

/** Outbound: backend → frontend tool dashboard data */
const UpdateToolDashboardMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD),
  items: z.array(ToolDashboardItemSchema),
});

/** Outbound: discovered skill inventory for the consolidated Skills tab. */
const UpdateSkillsListMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_SKILLS_LIST),
  skills: z.array(SkillDisplayItemSchema),
  issues: z.array(SkillDisplayIssueSchema),
});

/** Outbound: backend → frontend GitHub token status. */
const UpdateGitHubTokenStatusMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_GITHUB_TOKEN_STATUS),
  /** 'secret' = stored in SecretStorage; 'env' = GITHUB_TOKEN/GH_TOKEN env var; 'none' = missing. */
  status: z.enum(['secret', 'env', 'none']),
});

/**
 * The OAuth subscription providers a settings view signs in and out of. The
 * wire vocabulary for `SubscriptionProvider.id` in the host-neutral catalog
 * (`@controllers/modelAccess/subscriptionProviders`), which derives its id
 * type from here so a provider is spelled one way everywhere.
 */
export const SUBSCRIPTION_AUTH_PROVIDERS = ['chatgpt', 'grok'] as const;

/**
 * Outbound: backend → frontend subscription sign-in status, addressed by
 * provider. One shape for every provider — both carry the same session facts
 * and the same routing preference — so the payload names the provider instead
 * of the command doing it.
 */
const SubscriptionAuthStatusSchema = z.object({
  provider: z.enum(SUBSCRIPTION_AUTH_PROVIDERS),
  signedIn: z.boolean(),
  email: z.string().nullish(),
  accountId: z.string().nullish(),
  preferSubscription: z.boolean(),
});
export type SubscriptionAuthStatus = z.infer<
  typeof SubscriptionAuthStatusSchema
>;

/**
 * Sign-in status per provider, as a settings view holds it. Partial because a
 * provider that has not reported yet has no row; its section renders the
 * signed-out state until one lands.
 */
export type SubscriptionAuthStatuses = Readonly<
  Partial<Record<SubscriptionAuthStatus['provider'], SubscriptionAuthStatus>>
>;

const UpdateSubscriptionAuthStatusMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_SUBSCRIPTION_AUTH_STATUS),
  status: SubscriptionAuthStatusSchema,
});

const UpdateSubscriptionUsageMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_SUBSCRIPTION_USAGE),
  snapshots: SubscriptionUsageSnapshotsSchema,
});
const PRSubscriptionOwnerSchema = z.object({
  runId: RunIdSchema,
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

// ============================================================
// Outbound messages (extension host → settings webview)
// ============================================================

const SettingsViewOutboundMessageSchema = z.discriminatedUnion('command', [
  SetTabMessageSchema,
  UpdateMemoryMessageSchema,
  UpdateMemoryPreviewMessageSchema,
  UpdateModelSelectionMessageSchema,
  UpdateAgentSelectionMessageSchema,
  UpdateCustomAgentDirMessageSchema,
  UpdateAgentModePresetsMessageSchema,
  UpdateSettingsSnapshotMessageSchema,
  UpdateSkillsListMessageSchema,
  UpdateToolDashboardMessageSchema,
  UpdateGitHubTokenStatusMessageSchema,
  UpdateSubscriptionAuthStatusMessageSchema,
  UpdateSubscriptionUsageMessageSchema,
  UpdatePRSubscriptionsMessageSchema,
  UpdateLatexSettingsStatusMessageSchema,
  UpdateProfileMessageSchema,
]);

type SettingsViewOutboundMessage = z.infer<
  typeof SettingsViewOutboundMessageSchema
>;

export type SettingsViewOutboundHandlerRegistry =
  HandlerRegistry<SettingsViewOutboundMessage>;

export const dispatchSettingsViewOutbound = createDispatcher(
  SettingsViewOutboundMessageSchema,
);

/** Inbound message carrying a single boolean `enabled` toggle. */
function enabledFlag<T extends string>(command: T) {
  return z.object({ command: z.literal(command), enabled: z.boolean() });
}

/** Inbound message addressed to a provider by name. */
function providerCommand<T extends string>(command: T) {
  return z.object({ command: z.literal(command), provider: z.string().min(1) });
}

/** Inbound message addressed to a model by name. */
function modelCommand<T extends string>(command: T) {
  return z.object({
    command: z.literal(command),
    modelName: z.string().min(1),
  });
}

/** Inbound message addressed to an agent by name and source. */
function agentCommand<T extends string>(command: T) {
  return z.object({
    command: z.literal(command),
    agentName: z.string().min(1),
    agentSource: AgentSourceSchema,
  });
}

// Provider key inbound messages (settings-only)
const SetProviderKeyMessageSchema = providerCommand(
  SETTINGS_VIEW_COMMANDS.SET_PROVIDER_KEY,
);
const RemoveProviderKeyMessageSchema = providerCommand(
  SETTINGS_VIEW_COMMANDS.REMOVE_PROVIDER_KEY,
);
const OpenProviderKeyUrlMessageSchema = providerCommand(
  SETTINGS_VIEW_COMMANDS.OPEN_PROVIDER_KEY_URL,
);
const OpenExternalUrlMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.OPEN_EXTERNAL_URL),
  url: z.url(),
});

// Model selection inbound messages
const SetModelEnabledMessageSchema = modelCommand(
  SETTINGS_VIEW_COMMANDS.SET_MODEL_ENABLED,
).extend({ enabled: z.boolean() });

const SetModelReasoningLevelMessageSchema = modelCommand(
  SETTINGS_VIEW_COMMANDS.SET_MODEL_REASONING_LEVEL,
).extend({
  /** The reasoning level to set, or undefined/null to reset to model default. */
  level: ReasoningEffortSchema.nullable(),
});
const RequestModelAccessMessageSchema = modelCommand(
  SETTINGS_VIEW_COMMANDS.REQUEST_MODEL_ACCESS,
);
const ClearCopilotRouteMessageSchema = modelCommand(
  SETTINGS_VIEW_COMMANDS.CLEAR_COPILOT_ROUTE,
);

// Agent selection inbound messages
const OpenAgentYamlMessageSchema = agentCommand(
  SETTINGS_VIEW_COMMANDS.OPEN_AGENT_YAML,
);
const SetAgentEnabledMessageSchema = agentCommand(
  SETTINGS_VIEW_COMMANDS.SET_AGENT_ENABLED,
).extend({ category: AgentCategorySchema, enabled: z.boolean() });

const SetAllAgentsEnabledMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.SET_ALL_AGENTS_ENABLED),
  category: AgentCategorySchema,
  source: AgentSourceSchema,
  enabled: z.boolean(),
});
const OpenAgentFolderMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.OPEN_AGENT_FOLDER),
  folderType: z.literal('custom'),
});
const CreateAgentMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.CREATE_AGENT),
  category: AgentCategorySchema,
  mode: z.enum(['ai', 'template']).prefault('ai'),
});
const CustomizeAgentMessageSchema = agentCommand(
  SETTINGS_VIEW_COMMANDS.CUSTOMIZE_AGENT,
);
const DeleteCustomAgentMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.DELETE_CUSTOM_AGENT),
  agentName: z.string().min(1),
});
const RevealAgentFileMessageSchema = agentCommand(
  SETTINGS_VIEW_COMMANDS.REVEAL_AGENT_FILE,
);
const ViewRemoteAgentPromptMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.VIEW_REMOTE_AGENT_PROMPT),
  agentName: z.string().min(1),
});

// Custom agent directory inbound messages
const SetCustomAgentDirMessageSchema = commandOnly(
  SETTINGS_VIEW_COMMANDS.SET_CUSTOM_AGENT_DIR,
);
const ResetCustomAgentDirMessageSchema = commandOnly(
  SETTINGS_VIEW_COMMANDS.RESET_CUSTOM_AGENT_DIR,
);

// Agent team inbound messages
const ApplyAgentModePresetMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.APPLY_AGENT_MODE_PRESET),
  presetId: z.string().min(1),
});
const SaveAgentModePresetMessageSchema = commandOnly(
  SETTINGS_VIEW_COMMANDS.SAVE_AGENT_MODE_PRESET,
);
const DeleteAgentModePresetMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.DELETE_AGENT_MODE_PRESET),
  presetId: z.string().min(1),
});

// Tool dashboard inbound messages
const OpenToolInstallUrlMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.OPEN_TOOL_INSTALL_URL),
  url: z.url(),
});
const InstallToolExtensionMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.INSTALL_TOOL_EXTENSION),
  extensionId: z.string().min(1),
});
const RecheckToolStatusMessageSchema = commandOnly(
  SETTINGS_VIEW_COMMANDS.RECHECK_TOOL_STATUS,
);
const ToggleToolMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.TOGGLE_TOOL),
  toolId: z.string().min(1),
  enabled: z.boolean(),
});
const RunToolCommandMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.RUN_TOOL_COMMAND),
  toolId: z.string().min(1),
  kind: z.enum(['install', 'auth']),
});
export type ToolCommandKind = z.infer<
  typeof RunToolCommandMessageSchema
>['kind'];
// GitHub token messages (for PR subscription tool)
const GetGitHubTokenStatusMessageSchema = commandOnly(
  SETTINGS_VIEW_COMMANDS.GET_GITHUB_TOKEN_STATUS,
);
const SetGitHubTokenMessageSchema = commandOnly(
  SETTINGS_VIEW_COMMANDS.SET_GITHUB_TOKEN,
);
const RemoveGitHubTokenMessageSchema = commandOnly(
  SETTINGS_VIEW_COMMANDS.REMOVE_GITHUB_TOKEN,
);
const OpenGitHubTokenUrlMessageSchema = commandOnly(
  SETTINGS_VIEW_COMMANDS.OPEN_GITHUB_TOKEN_URL,
);
// ChatGPT subscription (Codex) sign-in messages
const SignInChatGptMessageSchema = commandOnly(
  SETTINGS_VIEW_COMMANDS.SIGN_IN_CHATGPT,
);
const SignOutChatGptMessageSchema = commandOnly(
  SETTINGS_VIEW_COMMANDS.SIGN_OUT_CHATGPT,
);
const SetChatGptPreferSubscriptionMessageSchema = enabledFlag(
  SETTINGS_VIEW_COMMANDS.SET_CHATGPT_PREFER_SUBSCRIPTION,
);
// Grok (xAI) subscription sign-in messages
const SignInGrokMessageSchema = commandOnly(
  SETTINGS_VIEW_COMMANDS.SIGN_IN_GROK,
);
const SignOutGrokMessageSchema = commandOnly(
  SETTINGS_VIEW_COMMANDS.SIGN_OUT_GROK,
);
const SetGrokPreferSubscriptionMessageSchema = enabledFlag(
  SETTINGS_VIEW_COMMANDS.SET_GROK_PREFER_SUBSCRIPTION,
);
const GetSubscriptionUsageMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.GET_SUBSCRIPTION_USAGE),
  forceRefresh: z.boolean().optional(),
});
const GetPRSubscriptionsMessageSchema = commandOnly(
  SETTINGS_VIEW_COMMANDS.GET_PR_SUBSCRIPTIONS,
);
const UnsubscribePRMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UNSUBSCRIBE_PR),
  key: z.string().min(1),
});
const OpenPRSubscriptionStreamMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.OPEN_PR_SUBSCRIPTION_STREAM),
  runId: RunIdSchema,
});

// LaTeX settings inbound messages
const ApplyLatexSettingsMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.APPLY_LATEX_SETTINGS),
  field: z.enum(['outDir', 'autoRevealExclude']).optional(),
  reset: z.boolean().optional(),
});
const InstallLatexWorkshopMessageSchema = commandOnly(
  SETTINGS_VIEW_COMMANDS.INSTALL_LATEX_WORKSHOP,
);
const RunInstallCommandMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.RUN_INSTALL_COMMAND),
  installCommand: z.string().min(1),
});

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
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_STATE_SETTING),
  key: z.string().min(1),
  value: StateSettingValueSchema.optional(),
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
    // Memory messages
    GetMemoryDataMessageSchema,
    GetMemoryPreviewMessageSchema,
    OpenMemoryFileMessageSchema,
    OpenMemoryFolderMessageSchema,
    DeleteMemoryMessageSchema,
    PinMemoryMessageSchema,
    UnpinMemoryMessageSchema,
    // Profile messages
    SignInMessageSchema,
    SignOutMessageSchema,
    SetProviderKeyMessageSchema,
    RemoveProviderKeyMessageSchema,
    OpenProviderKeyUrlMessageSchema,
    OpenExternalUrlMessageSchema,
    // Model selection messages
    SetModelEnabledMessageSchema,
    SetModelReasoningLevelMessageSchema,
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
  ],
);

export type SettingsViewInboundMessage = z.infer<
  typeof SettingsViewInboundMessageSchema
>;

/** Type helper for extracting a specific inbound message by command. */
export type SettingsMessageFor<
  C extends SettingsViewInboundMessage['command'],
> = Extract<SettingsViewInboundMessage, { command: C }>;
