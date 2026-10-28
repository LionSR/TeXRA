/**
 * Schema definitions for SettingsView messages.
 *
 * Public entry point and single home for the settings-view wire format:
 * combines the MemoryView and ProfileView message schemas with the
 * settings-specific data schemas, the outbound (backend → webview) message
 * union, and the inbound (webview → backend) message union plus their
 * dispatchers.
 */
import { Effect, Schema, Struct } from 'effect';
import { ReasoningEffortSchema } from 'llm-zoo/schemas';

import {
  SUBSCRIPTION_AUTH_PROVIDERS,
  type SettingsViewSnapshot,
  AgentModePresetSchema,
  AgentScanIssueSchema,
  AgentSourceSchema,
  ModelAvailabilityFieldsSchema,
  RunIdSchema,
  SkillDisplayIssueSchema,
  SkillDisplayItemSchema,
  WorkspaceStateKey,
} from '@texra-ai/harness/schemas';
import { SubscriptionAuthStatusSchema } from '@texra/shared/model/subscriptionAuth';
import { SubscriptionUsageSnapshotsSchema } from '@texra/shared/model/subscriptionUsage';
import { settingSchemaWithoutDefault } from '@texra/shared/settingsView/settingRows';
import {
  SETTINGS_VIEW_COMMANDS,
  WebviewReadyMessageSchema,
} from '@texra/shared/ipc';
import { ToolDependencyStatusSchema } from '@texra/shared/tools/toolPlugin';
import {
  createDispatcher,
  type HandlerRegistry,
} from '@texra/shared/utils/dispatcher';
import { TEXRA_SETTINGS } from '@texra/shared/settingsView/texraSettings';
import { SettingsTargetSchema } from './settingsTarget';
import { UpdateProfileMessageSchema } from './profileViewMessages';
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
import {
  PluginActionMessageSchema,
  PluginListItemSchema,
} from './pluginMessages';
import type { ModelProvider } from 'llm-zoo';

/** An absolute URL the host may open. */
const UrlSchema = Schema.String.check(
  Schema.makeFilter((value) => URL.canParse(value), { message: 'a URL' }),
);

/** Outbound schema to switch tabs, addressed by page or `page/section`. */
const SetTabMessageSchema = Schema.Struct({
  command: Schema.Literal(SETTINGS_VIEW_COMMANDS.SET_TAB),
  tab: SettingsTargetSchema,
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
export const DERIVED_SETTINGS_SNAPSHOTS = Object.freeze([
  'agents',
  'approval',
  'git-author',
  'skills',
  'telemetry',
  'latex',
  'memory',
] as const satisfies readonly SettingsViewSnapshot[]);

/** A snapshot whose whole payload is derived from the settings catalog. */
export type DerivedSettingsSnapshot =
  (typeof DERIVED_SETTINGS_SNAPSHOTS)[number];

/**
 * One snapshot's member of the outbound snapshot arm: its name plus one
 * `values` object carrying every catalog row tagged for that snapshot, keyed
 * by its canonical `texra.*` key and validated by the row's own schema.
 *
 * An arm reads the one declared shape instead of restating its fields, so a row added to a snapshot reaches the wire, the
 * backend read, and the webview apply step together. Keying by catalog key
 * also matches the inbound generic `UPDATE_STATE_SETTING` `{key, value}`
 * boundary, so both directions address a setting the same way.
 */
function snapshotMessage<S extends DerivedSettingsSnapshot>(snapshot: S) {
  return Schema.Struct({
    command: Schema.Literal(SETTINGS_VIEW_COMMANDS.UPDATE_SETTINGS_SNAPSHOT),
    snapshot: Schema.Literal(snapshot),
    values: Schema.Struct(
      Object.fromEntries(
        TEXRA_SETTINGS.snapshotEntries(snapshot).map((entry) => [
          entry.key,
          settingSchemaWithoutDefault(entry),
        ]),
      ),
    ),
  });
}

const [firstDerivedSnapshot, ...otherDerivedSnapshots] =
  DERIVED_SETTINGS_SNAPSHOTS;

/** Outbound: backend → frontend catalog-derived snapshot, keyed by `snapshot`. */
const UpdateSettingsSnapshotMessageSchema = Schema.Union([
  snapshotMessage(firstDerivedSnapshot),
  ...otherDerivedSnapshots.map(snapshotMessage),
]);

// ==================== Agent selection data schema ====================

/** Agent selection data for the settings view: one catalog agent. */
const AgentSelectionItemSchema = Schema.Struct({
  /** Its catalog name: its own, or `<plugin>:<name>` for an installed
   *  plugin's agent. */
  name: Schema.Trim.check(Schema.isMinLength(1)).check(
    Schema.isPattern(/^(?:[a-z0-9][a-z0-9-]*:)?[A-Za-z0-9][A-Za-z0-9_-]*$/u),
  ),
  /** Its file has a `task:` block: it is also launchable as a document task. */
  hasTask: Schema.Boolean,
  description: Schema.optional(Schema.String),
  source: AgentSourceSchema,
  filePath: Schema.optional(Schema.String),
  tools: Schema.optional(Schema.Array(Schema.String)),
  /**
   * On a customized copy: the source of the bundled agent it overrides, when
   * an update changed that agent since the copy was taken.
   */
  newerBuiltIn: Schema.optional(AgentSourceSchema),
  enabled: Schema.Boolean,
});
export type AgentSelectionItem = typeof AgentSelectionItemSchema.Type;

/** Outbound: backend → frontend agent selection data */
const UpdateAgentSelectionMessageSchema = Schema.Struct({
  command: Schema.Literal(SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_SELECTION),
  agents: Schema.Array(AgentSelectionItemSchema),
  customAgentIssues: Schema.Array(AgentScanIssueSchema).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});

// ==================== Model selection data schema ====================

/**
 * The model sources the Models tab groups its rows under, in display order.
 * A model whose source is outside this list never renders as a row, so the
 * controller admits only these. Every llm-zoo provider but `others` and
 * `copilot` (whose models TeXRA does not serve) is a source (checked below,
 * so a provider a new llm-zoo release adds fails to compile until it is
 * placed here), plus the Kimi Code subscription.
 */
const MODEL_SOURCES = [
  'openai',
  'anthropic',
  'google',
  'xai',
  'deepseek',
  'moonshot',
  'dashscope',
  'minimax',
  'glm',
  'meta',
  'kimiCode',
] as const;
type _EveryProviderIsASource = AssertNever<
  Exclude<
    `${ModelProvider}`,
    (typeof MODEL_SOURCES)[number] | 'others' | 'copilot'
  >
>;
type AssertNever<T extends never> = T;

/** {@link MODEL_SOURCES}, as the picker reads it. */
export const MODEL_SOURCE_ORDER: readonly string[] =
  Object.freeze(MODEL_SOURCES);

const ModelSelectionItemSchema = Schema.Struct({
  name: Schema.String,
  label: Schema.String,
  provider: Schema.String,
  enabled: Schema.Boolean,
  deprecated: Schema.Boolean,
  contextWindow: Schema.optional(Schema.String),
  cost: Schema.optional(Schema.String),
  /** Whether this model supports user-configurable reasoning effort. */
  supportsReasoningLevel: Schema.optional(Schema.Boolean),
  /** The model's default reasoning level from its static config. */
  defaultReasoningLevel: Schema.optional(ReasoningEffortSchema),
  /** The user's chosen reasoning level override (undefined = use default). */
  reasoningLevel: Schema.optional(ReasoningEffortSchema),
  /** Exact registry-declared effort vocabulary for this model. */
  supportedReasoningLevels: Schema.optional(
    Schema.Array(ReasoningEffortSchema),
  ),
  /** Whether this model qualifies as a "fast first response" pick (price-based). */
  isFast: Schema.optional(Schema.Boolean),
  /** Whether this model's API pricing earns the premium warning (price-based). */
  isExpensive: Schema.optional(Schema.Boolean),
  // Resolved once by modelOptionsFrom and carried verbatim so the
  // Models tab renders availability without re-deriving it at render time.
  ...ModelAvailabilityFieldsSchema.fields,
});
export type ModelSelectionItem = typeof ModelSelectionItemSchema.Type;

/** Outbound: backend → frontend model selection data */
const UpdateModelSelectionMessageSchema = Schema.Struct({
  command: Schema.Literal(SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION),
  models: Schema.Array(ModelSelectionItemSchema),
  helperModel: Schema.String,
  /** Whether the user prefers short (unpinned) model names. */
  preferShortModelNames: Schema.Boolean,
});
export type UpdateModelSelectionMessage =
  (typeof UpdateModelSelectionMessageSchema)['Type'];

// ============================================================
// Custom agent directory data schema
// ============================================================

/** Outbound: backend → frontend custom agent directory info */
const UpdateCustomAgentDirMessageSchema = Schema.Struct({
  command: Schema.Literal(SETTINGS_VIEW_COMMANDS.UPDATE_CUSTOM_AGENT_DIR),
  path: Schema.String,
  isDefault: Schema.Boolean,
});

// ============================================================
// Agent team data schema
// ============================================================

/** One team card: a team from the workspace's team catalog and where it came
 *  from. Only a custom team can be deleted. */
const SettingsTeamPresetSchema = AgentModePresetSchema.mapFields(
  Struct.assign({ source: Schema.Literals(['built-in', 'custom']) }),
);
export type SettingsTeamPreset = typeof SettingsTeamPresetSchema.Type;

/** Outbound: backend → frontend agent teams (built-in + custom) */
const UpdateAgentModePresetsMessageSchema = Schema.Struct({
  command: Schema.Literal(SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_MODE_PRESETS),
  /** Every launchable team in catalog order: the built-in teams, then the
   *  workspace's custom teams. */
  presets: Schema.Array(SettingsTeamPresetSchema),
  /**
   * Agent names that can lead a team (carry delegation tools), computed from
   * the agent registry so preset cards badge orchestrators by capability
   * instead of guessing from the agent's name.
   */
  orchestratorAgents: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /**
   * The team the workspace agents currently resolves to, or null when it runs
   * no team. Owned by the workspace agents so a preset card reports the applied team
   * rather than the last one the user clicked.
   */
  activePresetId: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});

// ============================================================
// Tool dashboard data schemas
// ============================================================

/** One tool a dashboard card groups, by name. */
const ToolInfoSchema = Schema.Struct({
  name: Schema.String,
});

/** One setup action exposed by a tool dashboard card. */
const ToolInstallActionSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('guide'),
    text: Schema.String.check(Schema.isMinLength(1)),
  }),
  Schema.Struct({
    kind: Schema.Literal('url'),
    url: UrlSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal('extension'),
    extensionId: Schema.String.check(Schema.isMinLength(1)),
  }),
  Schema.Struct({
    kind: Schema.Literal('command'),
    command: Schema.String.check(Schema.isMinLength(1)),
  }),
  Schema.Struct({
    kind: Schema.Literal('auth'),
    command: Schema.String.check(Schema.isMinLength(1)),
  }),
]);
export type ToolInstallAction = typeof ToolInstallActionSchema.Type;

/** One dashboard card; `settings` are its inline rows as [catalog key, label]. */
const ToolDashboardItemSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  tools: Schema.Array(ToolInfoSchema),
  status: ToolDependencyStatusSchema,
  requiresSetup: Schema.Boolean,
  statusLabel: Schema.optional(Schema.String),
  installActions: Schema.Array(ToolInstallActionSchema),
  configNotes: Schema.optional(Schema.String),
  statusDetail: Schema.optional(Schema.String),
  authNote: Schema.optional(Schema.String),
  toggleable: Schema.optional(Schema.Boolean),
  enabled: Schema.optional(Schema.Boolean),
  settings: Schema.optional(
    Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
  ),
});
export type ToolDashboardItem = typeof ToolDashboardItemSchema.Type;

/**
 * One row of the Plugins page and the TUI's `/plugins`: everything that adds
 * tools or agents, built once (`@texra/controllers/settingsView/pluginRows`). A
 * TeXRA plugin carries its dashboard card, an installed Claude Code or Codex
 * plugin its listing, and an MCP server from the user's `mcp.json` its name
 * and command. `usedBy` names the agents whose tool lists reach the row.
 */
const PluginRowSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('texra'),
    item: ToolDashboardItemSchema,
    usedBy: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal('installed'),
    plugin: PluginListItemSchema,
    usedBy: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal('mcp'),
    name: Schema.String.check(Schema.isMinLength(1)),
    command: Schema.String.check(Schema.isMinLength(1)),
    usedBy: Schema.Array(Schema.String),
  }),
]);
export type PluginRow = typeof PluginRowSchema.Type;

/** Outbound: the Plugins page's rows and what the MCP config file's
 *  invalid entries raise. */
const UpdatePluginsMessageSchema = Schema.Struct({
  command: Schema.Literal(SETTINGS_VIEW_COMMANDS.UPDATE_PLUGINS),
  rows: Schema.Array(PluginRowSchema),
  mcpWarnings: Schema.Array(Schema.String),
});

/** Outbound: the Skills tab's skills and their issues. */
const UpdateSkillsListMessageSchema = Schema.Struct({
  command: Schema.Literal(SETTINGS_VIEW_COMMANDS.UPDATE_SKILLS_LIST),
  skills: Schema.Array(SkillDisplayItemSchema),
  issues: Schema.Array(SkillDisplayIssueSchema),
});

/** Outbound: backend → frontend GitHub token status. */
const UpdateGitHubTokenStatusMessageSchema = Schema.Struct({
  command: Schema.Literal(SETTINGS_VIEW_COMMANDS.UPDATE_GITHUB_TOKEN_STATUS),
  /** 'secret' = stored in SecretStorage; 'env' = GITHUB_TOKEN/GH_TOKEN env var; 'none' = missing. */
  status: Schema.Literals(['secret', 'env', 'none']),
});

const UpdateSubscriptionAuthStatusMessageSchema = Schema.Struct({
  command: Schema.Literal(
    SETTINGS_VIEW_COMMANDS.UPDATE_SUBSCRIPTION_AUTH_STATUS,
  ),
  status: SubscriptionAuthStatusSchema,
});

const UpdateSubscriptionUsageMessageSchema = Schema.Struct({
  command: Schema.Literal(SETTINGS_VIEW_COMMANDS.UPDATE_SUBSCRIPTION_USAGE),
  snapshots: SubscriptionUsageSnapshotsSchema,
});
const PRSubscriptionOwnerSchema = Schema.Struct({
  runId: RunIdSchema,
  label: Schema.String,
});

const PRSubscriptionEntrySchema = Schema.Struct({
  key: Schema.String.check(Schema.isMinLength(1)),
  owners: Schema.Array(PRSubscriptionOwnerSchema),
});
export type PRSubscriptionEntry = typeof PRSubscriptionEntrySchema.Type;

/** Outbound: backend → frontend active PR subscriptions. */
const UpdatePRSubscriptionsMessageSchema = Schema.Struct({
  command: Schema.Literal(SETTINGS_VIEW_COMMANDS.UPDATE_PR_SUBSCRIPTIONS),
  subscriptions: Schema.Array(PRSubscriptionEntrySchema),
});

// ============================================================
// LaTeX settings data schemas
// ============================================================

/** Status of each recommended LaTeX-related VS Code setting. */
const LatexSettingsStatusSchema = Schema.Struct({
  outDir: Schema.Boolean,
  autoRevealExclude: Schema.Boolean,
  texDistributionInstalled: Schema.Boolean,
  latexWorkshopInstalled: Schema.Boolean,
  latexdiffInstalled: Schema.Boolean,
  latexindentInstalled: Schema.Boolean,
  texcountInstalled: Schema.Boolean,
  imageProcessingInstalled: Schema.Boolean,
  platform: Schema.Literals(['darwin', 'win32', 'linux']),
  pdflatexPath: Schema.NullOr(Schema.String),
  latexmkPath: Schema.NullOr(Schema.String),
  latexdiffPath: Schema.NullOr(Schema.String),
  latexindentPath: Schema.NullOr(Schema.String),
  texcountPath: Schema.NullOr(Schema.String),
  ghostscriptPath: Schema.NullOr(Schema.String),
  graphicsmagickPath: Schema.NullOr(Schema.String),
  /** Detected package manager available on the system (null = none found). */
  packageManager: Schema.NullOr(Schema.Literals(['brew', 'apt', 'scoop'])),
});
export type LatexSettingsStatus = typeof LatexSettingsStatusSchema.Type;

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
const UpdateLatexSettingsStatusMessageSchema = Schema.Struct({
  command: Schema.Literal(SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_SETTINGS_STATUS),
  settings: LatexSettingsStatusSchema,
});

// ============================================================
// Outbound messages (extension host → settings webview)
// ============================================================

const SettingsViewOutboundMessageSchema = Schema.Union([
  SetTabMessageSchema,
  UpdateMemoryMessageSchema,
  UpdateMemoryPreviewMessageSchema,
  UpdateModelSelectionMessageSchema,
  UpdateAgentSelectionMessageSchema,
  UpdateCustomAgentDirMessageSchema,
  UpdateAgentModePresetsMessageSchema,
  UpdateSettingsSnapshotMessageSchema,
  UpdateSkillsListMessageSchema,
  UpdatePluginsMessageSchema,
  UpdateGitHubTokenStatusMessageSchema,
  UpdateSubscriptionAuthStatusMessageSchema,
  UpdateSubscriptionUsageMessageSchema,
  UpdatePRSubscriptionsMessageSchema,
  UpdateLatexSettingsStatusMessageSchema,
  UpdateProfileMessageSchema,
]);

export type SettingsViewOutboundMessage =
  (typeof SettingsViewOutboundMessageSchema)['Type'];

export type SettingsViewOutboundHandlerRegistry =
  HandlerRegistry<SettingsViewOutboundMessage>;

export const dispatchSettingsViewOutbound = createDispatcher(
  SettingsViewOutboundMessageSchema,
);

/** Inbound message addressed to a provider by name. */
function providerCommand<T extends string>(command: T) {
  return Schema.Struct({
    command: Schema.Literal(command),
    provider: Schema.String.check(Schema.isMinLength(1)),
  });
}

/** Inbound message addressed to a model by name. */
function modelCommand<T extends string>(command: T) {
  return Schema.Struct({
    command: Schema.Literal(command),
    modelName: Schema.String.check(Schema.isMinLength(1)),
  });
}

/** Inbound message addressed to an agent by name and source. */
function agentCommand<T extends string>(command: T) {
  return Schema.Struct({
    command: Schema.Literal(command),
    agentName: Schema.String.check(Schema.isMinLength(1)),
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
const OpenExternalUrlMessageSchema = Schema.Struct({
  command: Schema.Literal(SETTINGS_VIEW_COMMANDS.OPEN_EXTERNAL_URL),
  url: UrlSchema,
});

// Model selection inbound messages
const SetModelEnabledMessageSchema = modelCommand(
  SETTINGS_VIEW_COMMANDS.SET_MODEL_ENABLED,
).mapFields(Struct.assign({ enabled: Schema.Boolean }));

const SetModelReasoningLevelMessageSchema = modelCommand(
  SETTINGS_VIEW_COMMANDS.SET_MODEL_REASONING_LEVEL,
).mapFields(
  Struct.assign({
    /** The reasoning level to set, or undefined/null to reset to model default. */
    level: Schema.NullOr(ReasoningEffortSchema),
  }),
);

// Agent selection inbound messages
const OpenAgentYamlMessageSchema = agentCommand(
  SETTINGS_VIEW_COMMANDS.OPEN_AGENT_YAML,
);
const SetAgentEnabledMessageSchema = agentCommand(
  SETTINGS_VIEW_COMMANDS.SET_AGENT_ENABLED,
).mapFields(Struct.assign({ enabled: Schema.Boolean }));

const SetAllAgentsEnabledMessageSchema = Schema.Struct({
  command: Schema.Literal(SETTINGS_VIEW_COMMANDS.SET_ALL_AGENTS_ENABLED),
  source: AgentSourceSchema,
  enabled: Schema.Boolean,
});
const OpenAgentFolderMessageSchema = Schema.Struct({
  command: Schema.Literal(SETTINGS_VIEW_COMMANDS.OPEN_AGENT_FOLDER),
});
const CreateAgentMessageSchema = Schema.Struct({
  command: Schema.Literal(SETTINGS_VIEW_COMMANDS.CREATE_AGENT),
  /** From the document-task template rather than the chat one. */
  task: Schema.Boolean,
});
const CustomizeAgentMessageSchema = agentCommand(
  SETTINGS_VIEW_COMMANDS.CUSTOMIZE_AGENT,
);
const DeleteCustomAgentMessageSchema = Schema.Struct({
  command: Schema.Literal(SETTINGS_VIEW_COMMANDS.DELETE_CUSTOM_AGENT),
  agentName: Schema.String.check(Schema.isMinLength(1)),
});
const KeepCustomAgentMessageSchema = Schema.Struct({
  command: Schema.Literal(SETTINGS_VIEW_COMMANDS.KEEP_CUSTOM_AGENT),
  agentName: Schema.String.check(Schema.isMinLength(1)),
});
const RevealAgentFileMessageSchema = agentCommand(
  SETTINGS_VIEW_COMMANDS.REVEAL_AGENT_FILE,
);

// Custom agent directory inbound messages
const SetCustomAgentDirMessageSchema = commandOnly(
  SETTINGS_VIEW_COMMANDS.SET_CUSTOM_AGENT_DIR,
);
const ResetCustomAgentDirMessageSchema = commandOnly(
  SETTINGS_VIEW_COMMANDS.RESET_CUSTOM_AGENT_DIR,
);

// Agent team inbound messages
const ApplyAgentModePresetMessageSchema = Schema.Struct({
  command: Schema.Literal(SETTINGS_VIEW_COMMANDS.APPLY_AGENT_MODE_PRESET),
  presetId: Schema.String.check(Schema.isMinLength(1)),
});
const SaveAgentModePresetMessageSchema = commandOnly(
  SETTINGS_VIEW_COMMANDS.SAVE_AGENT_MODE_PRESET,
);
const DeleteAgentModePresetMessageSchema = Schema.Struct({
  command: Schema.Literal(SETTINGS_VIEW_COMMANDS.DELETE_AGENT_MODE_PRESET),
  presetId: Schema.String.check(Schema.isMinLength(1)),
});

// Tool dashboard inbound messages
const InstallToolExtensionMessageSchema = Schema.Struct({
  command: Schema.Literal(SETTINGS_VIEW_COMMANDS.INSTALL_TOOL_EXTENSION),
  extensionId: Schema.String.check(Schema.isMinLength(1)),
});
const RecheckToolStatusMessageSchema = commandOnly(
  SETTINGS_VIEW_COMMANDS.RECHECK_TOOL_STATUS,
);
const ToggleToolMessageSchema = Schema.Struct({
  command: Schema.Literal(SETTINGS_VIEW_COMMANDS.TOGGLE_TOOL),
  toolId: Schema.String.check(Schema.isMinLength(1)),
  enabled: Schema.Boolean,
});
const RunToolCommandMessageSchema = Schema.Struct({
  command: Schema.Literal(SETTINGS_VIEW_COMMANDS.RUN_TOOL_COMMAND),
  toolId: Schema.String.check(Schema.isMinLength(1)),
  kind: Schema.Literals(['install', 'auth']),
});
export type ToolCommandKind =
  (typeof RunToolCommandMessageSchema)['Type']['kind'];
// GitHub token messages (for PR subscription tool)
const SetGitHubTokenMessageSchema = commandOnly(
  SETTINGS_VIEW_COMMANDS.SET_GITHUB_TOKEN,
);
const RemoveGitHubTokenMessageSchema = commandOnly(
  SETTINGS_VIEW_COMMANDS.REMOVE_GITHUB_TOKEN,
);
const OpenGitHubTokenUrlMessageSchema = commandOnly(
  SETTINGS_VIEW_COMMANDS.OPEN_GITHUB_TOKEN_URL,
);
// Subscription sign-in messages, addressed by provider
const SignInSubscriptionMessageSchema = Schema.Struct({
  command: Schema.Literal(SETTINGS_VIEW_COMMANDS.SIGN_IN_SUBSCRIPTION),
  provider: Schema.Literals(SUBSCRIPTION_AUTH_PROVIDERS),
});
const SignOutSubscriptionMessageSchema = Schema.Struct({
  command: Schema.Literal(SETTINGS_VIEW_COMMANDS.SIGN_OUT_SUBSCRIPTION),
  provider: Schema.Literals(SUBSCRIPTION_AUTH_PROVIDERS),
});
const SetSubscriptionPreferenceMessageSchema = Schema.Struct({
  command: Schema.Literal(SETTINGS_VIEW_COMMANDS.SET_SUBSCRIPTION_PREFERENCE),
  provider: Schema.Literals(SUBSCRIPTION_AUTH_PROVIDERS),
  enabled: Schema.Boolean,
});
const GetSubscriptionUsageMessageSchema = Schema.Struct({
  command: Schema.Literal(SETTINGS_VIEW_COMMANDS.GET_SUBSCRIPTION_USAGE),
  forceRefresh: Schema.optional(Schema.Boolean),
});
const UnsubscribePRMessageSchema = Schema.Struct({
  command: Schema.Literal(SETTINGS_VIEW_COMMANDS.UNSUBSCRIBE_PR),
  key: Schema.String.check(Schema.isMinLength(1)),
});
const OpenPRSubscriptionStreamMessageSchema = Schema.Struct({
  command: Schema.Literal(SETTINGS_VIEW_COMMANDS.OPEN_PR_SUBSCRIPTION_STREAM),
  runId: RunIdSchema,
});

// LaTeX settings inbound messages
const ApplyLatexSettingsMessageSchema = Schema.Struct({
  command: Schema.Literal(SETTINGS_VIEW_COMMANDS.APPLY_LATEX_SETTINGS),
  field: Schema.optional(Schema.Literals(['outDir', 'autoRevealExclude'])),
  reset: Schema.optional(Schema.Boolean),
});
const InstallLatexWorkshopMessageSchema = commandOnly(
  SETTINGS_VIEW_COMMANDS.INSTALL_LATEX_WORKSHOP,
);
const RunInstallCommandMessageSchema = Schema.Struct({
  command: Schema.Literal(SETTINGS_VIEW_COMMANDS.RUN_INSTALL_COMMAND),
  installCommand: Schema.String.check(Schema.isMinLength(1)),
});

// Generic catalog-driven setting write. This boundary accepts exactly the
// value shapes used by catalog entries; the selected entry's schema performs
// the narrower per-key validation in the backend handler.
const StateSettingValueSchema = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Array(Schema.String),
  Schema.Record(Schema.String, Schema.String),
  Schema.Null,
]);
export type StateSettingValue = typeof StateSettingValueSchema.Type;

const UpdateStateSettingMessageSchema = Schema.Struct({
  command: Schema.Literal(SETTINGS_VIEW_COMMANDS.UPDATE_STATE_SETTING),
  key: Schema.String.check(Schema.isMinLength(1)),
  value: Schema.optional(StateSettingValueSchema),
});

/** One skill, or one skill source, switched on or off. The host applies it
 *  to the list it holds, so a second switch sent before the first one's
 *  snapshot returned cannot undo it. */
const SetSkillEnabledMessageSchema = Schema.Struct({
  command: Schema.Literal(SETTINGS_VIEW_COMMANDS.SET_SKILL_ENABLED),
  key: Schema.Literals([
    WorkspaceStateKey.DISABLED_SKILLS,
    WorkspaceStateKey.DISABLED_SKILL_SOURCES,
  ]),
  item: Schema.String.check(Schema.isMinLength(1)),
  enabled: Schema.Boolean,
});

// ============================================================
// Discriminated union of all inbound messages
// ============================================================

export const SettingsViewInboundMessageSchema = Schema.Union([
  // Lifecycle
  WebviewReadyMessageSchema,
  // Tool dashboard messages
  InstallToolExtensionMessageSchema,
  RecheckToolStatusMessageSchema,
  ToggleToolMessageSchema,
  RunToolCommandMessageSchema,
  PluginActionMessageSchema,
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
  SetProviderKeyMessageSchema,
  RemoveProviderKeyMessageSchema,
  OpenProviderKeyUrlMessageSchema,
  OpenExternalUrlMessageSchema,
  // Model selection messages
  SetModelEnabledMessageSchema,
  SetModelReasoningLevelMessageSchema,
  // Agent selection messages
  OpenAgentYamlMessageSchema,
  SetAgentEnabledMessageSchema,
  SetAllAgentsEnabledMessageSchema,
  OpenAgentFolderMessageSchema,
  CreateAgentMessageSchema,
  CustomizeAgentMessageSchema,
  DeleteCustomAgentMessageSchema,
  KeepCustomAgentMessageSchema,
  RevealAgentFileMessageSchema,
  // Custom agent directory messages
  SetCustomAgentDirMessageSchema,
  ResetCustomAgentDirMessageSchema,
  // GitHub token messages
  SetGitHubTokenMessageSchema,
  RemoveGitHubTokenMessageSchema,
  OpenGitHubTokenUrlMessageSchema,
  // Subscription sign-in messages
  SignInSubscriptionMessageSchema,
  SignOutSubscriptionMessageSchema,
  SetSubscriptionPreferenceMessageSchema,
  GetSubscriptionUsageMessageSchema,
  UnsubscribePRMessageSchema,
  OpenPRSubscriptionStreamMessageSchema,
  // Generic catalog-driven scalar-setting write
  UpdateStateSettingMessageSchema,
  SetSkillEnabledMessageSchema,
  // Agent team messages
  ApplyAgentModePresetMessageSchema,
  SaveAgentModePresetMessageSchema,
  DeleteAgentModePresetMessageSchema,
]);

export type SettingsViewInboundMessage =
  (typeof SettingsViewInboundMessageSchema)['Type'];
