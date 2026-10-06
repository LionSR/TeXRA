// Third-party imports
import { z } from 'zod';

// Local imports - shared constants & state keys
import {
  TEXRA_APPROVAL_POLICY_CONFIG_KEY,
  TEXRA_APPROVAL_POLICY_DEFAULT,
  TexraApprovalPolicySchema,
} from '@shared/approvalPolicy';
import {
  ActiveSkillSourceScopeSchema,
  AGENT_SKILLS_ENABLED_DEFAULT,
  AgentModePresetSchema,
  WorkspaceAgentsSelectionSchema,
  AgentSkillsEnabledSchema,
  HiddenCustomAgentKeysSchema,
  CHATGPT_CODEX_CONTEXT_WINDOW_SETTING,
  CHILD_RUN_CONCURRENCY_BUDGET_SETTING,
  ChatgptCodexContextWindowSchema,
  ChildRunConcurrencyBudgetSchema,
  GOAL_MAX_COST_SETTING,
  GoalMaxCostSchema,
  MODEL_COMPACTION_THRESHOLD_SETTING,
  MODEL_RETRY_MAX_ATTEMPTS_SETTING,
  ModelCompactionThresholdPercentSchema,
  RESUME_ON_OPEN_SETTING,
  ResumeOnOpenSchema,
  ModelRetryMaxAttemptsSchema,
  INHERITED_WORKSPACE_AGENTS,
  QualifiedSkillNameSchema,
} from '@shared/schemas';
import { DEFAULT_HELPER_MODEL } from '@shared/constants/defaultModels';
import {
  PROVIDER_ENDPOINT_STATE_ENTRIES,
  PROVIDER_REGION_SETTINGS,
} from '@shared/state/providerSettings';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';

// ============================================================================
// Git defaults
// ============================================================================

export const DEFAULT_GIT_AUTHOR_NAME = 'texra-ai';
export const DEFAULT_GIT_AUTHOR_EMAIL = 'texra-ai@users.noreply.github.com';

/**
 * Keep file-oriented tools inside the active working directory unless the
 * user explicitly grants them access to arbitrary filesystem paths.
 */
const DEFAULT_TOOL_PATH_PROTECTION_ENABLED = true;

/**
 * The settings catalog, by owner. This module declares the row shape and the
 * harness's own rows (model, approvals, retries, compaction, concurrency,
 * skills, logging). An app declares its rows (its plugins' among them)
 * beside its code; `settingsCatalog` concatenates them after these, and
 * `installProcessRuntime` installs that catalog for the harness's own readers.
 *
 * One row carries the catalog facts:
 *
 * - **`slot`** — where the value is stored (`config` / `workspaceState` /
 *   `repoState` / `globalState`); the same on every host.
 * - **`surfaces`** — which catalog-driven *UI* renders the row (settings view,
 *   CLI `/config`, the Models tab's per-provider controls).
 * - **`onWrite`** — write-time consequences declared once, so the CLI form and
 *   the webview Models tab cannot enforce different rules (the Kimi Code /
 *   OpenRouter mutual exclusion used to exist on one path only).
 *
 * Everything downstream is a filter over these rows: the CLI unknown-key set,
 * the `/config` panel, the settings-view write gate, the Models tab rows, and
 * `entry.slot`.
 */

/**
 * The product hosts, spelled once: for settings and `unavailableHosts`.
 * `sdk` is the agent package embedded in someone else's process.
 */
export type SettingHost = 'vscode' | 'cli' | 'desktop' | 'sdk';

/**
 * Storage slot a setting is read from / written to. `repoState` is shared by
 * every checkout of one git repository (keyed by its root in the global
 * database), so a repository has one value on every host and in every
 * worktree.
 */
type SettingStore = 'config' | 'workspaceState' | 'repoState' | 'globalState';

export type SettingsViewSnapshot =
  | 'agents'
  | 'approval'
  | 'git-author'
  | 'latex'
  | 'memory'
  | 'models'
  | 'profile'
  | 'skills'
  | 'telemetry';

/** One provider's control group in the Models tab. */
interface ModelsTabSurface {
  /** Canonical provider id whose expanded settings show this control. */
  readonly provider: string;
  readonly label: string;
  readonly description: string;
  readonly warning?: string;
  readonly warningUrl?: string;
  readonly warningUrlLabel?: string;
}

/** Catalog-driven UIs that render the row. Absent means no UI renders it. */
interface SettingSurfaces {
  /**
   * Rendered by the extension/desktop settings view; the value names the
   * snapshot rebroadcast after a write. Presence also makes the row writable
   * through the generic `UPDATE_STATE_SETTING` boundary.
   */
  readonly settingsView?: SettingsViewSnapshot;
  /** Listed as an editable row in the CLI `/config` panel. */
  readonly cliConfig?: true;
  /** Shown as a per-provider toggle in the Models tab. */
  readonly models?: readonly ModelsTabSurface[];
}

/** Consequences of writing a row, declared once for every write path. */
interface SettingWriteEffects {
  /**
   * Catalog keys forced to `false` when this row is written `true` — mutually
   * exclusive routes. Applied by `writeSetting`, so every host inherits it.
   */
  readonly disablesWhenEnabled?: readonly string[];
  /**
   * Writing the row changes which models are available or how they route, so
   * hosts must recompute their cached model options.
   */
  readonly invalidatesModelOptions?: true;
}

export interface StateSettingEntry {
  /**
   * Canonical `texra.*` key — identical to the config / WorkspaceState /
   * GlobalState slot the extension already uses.
   */
  readonly key: string;
  /**
   * Zod schema carrying both validation and the `.prefault()` default applied
   * when the key is absent. `schema.parse(undefined)` yields that default.
   */
  readonly schema: z.ZodType;
  /** Short label for compact settings UIs; falls back to the stripped key. */
  readonly title?: string;
  /** Human-readable description, shared across every host that renders it. */
  readonly description?: string;
  /** Grouping label for settings UIs. Required once a UI renders the row. */
  readonly category?: string;
  /** Where the value is stored, the same on every host. */
  readonly slot: SettingStore;
  /** Config-backed target, workspace when omitted; `global`/`local` skip the project file. */
  readonly configTarget?: 'global' | 'workspace' | 'local';
  /**
   * A `global` row a project file may still switch off: its project value
   * counts unless it is `true`, so a repository can opt out (telemetry) but
   * never opt in. A malformed project value counts too, and fails closed.
   */
  readonly projectMayOptOut?: true;
  /** Which catalog-driven UIs render the row. */
  readonly surfaces?: SettingSurfaces;
  /** Write-time consequences applied by every write path. */
  readonly onWrite?: SettingWriteEffects;
  /**
   * Per-value descriptions for an enum setting, aligned 1:1 with the schema's
   * enum options (see {@link settingEnumOptions}). The option *values* are
   * derived from the schema, not restated here.
   */
  readonly enumDescriptions?: readonly string[];
  /** Display labels for enum options, aligned 1:1 with the schema options. */
  readonly enumLabels?: readonly string[];
  /**
   * Delegate editing to an existing list form (e.g. `ModelListForm`) instead of
   * the scalar read/write accessor.
   */
  readonly openForm?: string;
}

/** A row at least one catalog-driven UI renders, so display copy is present. */
export type SurfacedSettingEntry = StateSettingEntry & {
  readonly description: string;
  readonly category: string;
  readonly surfaces: SettingSurfaces;
};

/** A row the extension/desktop settings view owns the write path for. */
export type SettingsViewStateSettingEntry = SurfacedSettingEntry & {
  readonly surfaces: SettingSurfaces & {
    readonly settingsView: SettingsViewSnapshot;
  };
};

/** A row a plugin declares, with the short label its Plugins-page card shows
 *  (the card already names the plugin, so 'Model' rather than 'Codex model'). */
export interface PluginSettingRow {
  readonly row: SurfacedSettingEntry;
  readonly label: string;
}

// ============================================================================
// Row builders
// ============================================================================

/** A surfaced row as written: display copy and surfaces are required. */
export type SurfacedSettingInput = Omit<
  StateSettingEntry,
  'surfaces' | 'description' | 'category'
> & {
  readonly description: string;
  readonly category: string;
  readonly surfaces: SettingSurfaces;
};

/**
 * A row at least one settings UI renders. Display copy is required at the call
 * site, so a rendered row can never fall back to an empty label.
 */
export function surfacedSetting(
  entry: SurfacedSettingInput,
): SurfacedSettingEntry {
  return entry;
}

/**
 * A Models-tab provider toggle: a globally-scoped boolean that renders both as
 * a profile row and as one per-provider control on the Models tab. These rows
 * differ only in their default, copy, and Models-tab control,
 * so the uniform framing is written once here: the `category: 'model'` /
 * `settingsView: 'profile'` / Models-tab surface `globalProviderToggle` gives
 * the GlobalState toggles, plus the `configTarget: 'global'` these config-tree
 * rows require (the GlobalState toggles instead set `cliConfig`). Returns a
 * `CORE_SETTING_ROWS` body (key and slot are added by the config-tree
 * mapping).
 */
function modelProviderToggle(opts: {
  readonly default: boolean;
  readonly title: string;
  readonly description: string;
  readonly model: ModelsTabSurface;
}): Omit<StateSettingEntry, 'key' | 'slot'> {
  return {
    schema: z.boolean().prefault(opts.default),
    configTarget: 'global',
    title: opts.title,
    description: opts.description,
    category: 'model',
    surfaces: { settingsView: 'profile', models: [opts.model] },
  };
}

/** A global provider knob with no settings-view row (`.texra/config.json`). */
const GLOBAL_MODEL_ROW = { configTarget: 'global', category: 'model' } as const;
function configToggle(on: boolean, title: string, description: string) {
  const schema = z.boolean().prefault(on);
  return { ...GLOBAL_MODEL_ROW, schema, title, description };
}

/**
 * The `globalState` analog of `modelProviderToggle`: a boolean every host
 * stores in GlobalState, rendered as a profile row, a CLI `/config` row, and
 * one Models-tab control. The control's label and description are the row's
 * title and description, so the copy is written once.
 */
function globalProviderToggle(opts: {
  readonly key: string;
  readonly default: boolean;
  readonly onWrite?: SettingWriteEffects;
  readonly model: ModelsTabSurface;
}): SurfacedSettingEntry {
  return surfacedSetting({
    key: opts.key,
    schema: z.boolean().prefault(opts.default),
    title: opts.model.label,
    description: opts.model.description,
    category: 'model',
    slot: 'globalState',
    ...(opts.onWrite && { onWrite: opts.onWrite }),
    surfaces: {
      settingsView: 'profile',
      cliConfig: true,
      models: [opts.model],
    },
  });
}

// ============================================================================
// Core (config-tree) rows
// ============================================================================

/**
 * The ChatGPT and Grok subscription routes apply only with OpenRouter off, so
 * preferring one clears the OpenRouter switch on every write path.
 */
const SUBSCRIPTION_PREFERENCE_WRITE: SettingWriteEffects = {
  disablesWhenEnabled: [GlobalStateKey.USE_OPENROUTER],
};

/**
 * Every config-file-backed setting, keyed by its dotted path under `texra.`.
 *
 * All three hosts read `.texra/config.json` and that storage is flat, so the
 * key and the slot are derived rather than restated; a row carries the schema
 * (with its `.prefault()` default), the copy, and which UI
 * renders it — exactly the shape every state-backed row below already uses.
 *
 * The record's own declaration order is the catalog order, including the
 * Models tab's control order: reordering these keys reorders that UI.
 */
const HARNESS_CONFIG_ROWS: Record<
  string,
  Omit<StateSettingEntry, 'key' | 'slot'>
> = {
  childRunConcurrencyBudget: {
    schema: ChildRunConcurrencyBudgetSchema,
    title: 'Agents at once',
    description: CHILD_RUN_CONCURRENCY_BUDGET_SETTING.description,
    category: 'agents',
    surfaces: { settingsView: 'agents', cliConfig: true },
  },
  // Global: how one person wants their windows to open.
  resumeOnOpen: {
    schema: ResumeOnOpenSchema,
    configTarget: 'global',
    title: 'Interrupted tasks',
    description: RESUME_ON_OPEN_SETTING.description,
    category: 'agents',
    enumLabels: ['Ask', 'Resume automatically'],
    surfaces: { settingsView: 'approval', cliConfig: true },
  },
  // Global: a committed project config must not raise or remove the user's cap.
  'goal.maxCostUsd': {
    schema: GoalMaxCostSchema,
    configTarget: 'global',
    title: 'Goal spend cap (USD)',
    description: GOAL_MAX_COST_SETTING.description,
    category: 'tools',
    surfaces: { settingsView: 'approval', cliConfig: true },
  },
  // The provider toggles below are `configTarget: 'global'`: they describe how
  // you talk to a provider, not a property of one project. Writes go to the
  // global file past the open-workspace write guard; reads stay merged, so a
  // workspace override stays honored (stranded values: #11173). Only
  // server-side state is a user choice (data retention); the transport knobs
  // have no settings-view row and live in `.texra/config.json`.
  'model.gpt5ReasoningSummary': configToggle(
    false,
    'GPT-5 reasoning summary',
    "Show the model's reasoning steps alongside its output when using GPT-5 models. Requires an OpenAI account with access to reasoning features.",
  ),
  'model.useGoogleInteractionsServerState': modelProviderToggle({
    default: true,
    title: 'Server-side conversation state',
    description:
      "Store Google Interactions conversation state on Google's servers via previous_interaction_id chaining, sending only the new turn each round. Google then retains the conversation for a limited period to enable chaining. Enabled by default. Disable to keep conversations off Google's servers — stateless mode resends the full transcript each round (store:false).",
    model: {
      provider: 'google',
      label: 'Server-side conversation state',
      description:
        "Store Interactions conversation state on Google's servers (send only the new turn each round; Google retains the conversation for a limited period to enable chaining). Disable to keep conversations off Google's servers and resend the full transcript each round.",
    },
  }),
  'model.useGoogleBackgroundResponses': configToggle(
    false,
    'Google background responses',
    'Run Google workflow generations as background Interactions (submit + poll) instead of one long streamed request. Requires server-side conversation state and a model that supports background execution. Off by default; unsupported models fall back automatically.',
  ),
  'model.useBackgroundResponses': configToggle(
    true,
    'Background responses',
    'Keep long-running OpenAI requests alive in the background (polling) instead of timing out after 10 minutes. Applies automatically to GPT models running a text-only agent (one without tools); ignored otherwise. Disable to fall back to synchronous streaming requests.',
  ),
  'model.openaiFastTier': configToggle(
    false,
    'Fast processing',
    "Send OpenAI requests on OpenAI's fast service tier, for models that offer it: faster responses at a higher per-token price, which run costs reflect.",
  ),
  'model.openaiParallelToolCalls': configToggle(
    true,
    'Parallel tool calls',
    'Let OpenAI models use multiple tools at the same time for faster results. Enabled by default; disable for models that require sequential tool run.',
  ),
  // No `configTarget`: both runtime readers resolve the *merged* config value
  // through `readSettingFrom`, so narrowing the row to the global scope would
  // hide (and block writes to) a workspace override the runtime honors.
  'model.compactionThresholdPercent': {
    schema: ModelCompactionThresholdPercentSchema,
    title: 'Compaction threshold',
    description: MODEL_COMPACTION_THRESHOLD_SETTING.description,
    category: 'model',
    surfaces: { settingsView: 'agents', cliConfig: true },
  },
  'model.retry.maxAttempts': {
    schema: ModelRetryMaxAttemptsSchema,
    title: 'Automatic retries',
    description: MODEL_RETRY_MAX_ATTEMPTS_SETTING.description,
    category: 'model',
    surfaces: { settingsView: 'agents', cliConfig: true },
  },
  'chatgptCodex.preferSubscription': {
    schema: z.boolean().prefault(false),
    description:
      'Prefer your signed-in ChatGPT subscription for Codex-eligible OpenAI models instead of API-key routing. Experimental. Subscription routing defaults to a 272K-token input budget; use chatgptCodex.contextWindowK to override it.',
    onWrite: SUBSCRIPTION_PREFERENCE_WRITE,
  },
  'chatgptCodex.contextWindowK': {
    schema: ChatgptCodexContextWindowSchema,
    title: 'Subscription input token budget (K tokens)',
    description: CHATGPT_CODEX_CONTEXT_WINDOW_SETTING.description,
    category: 'model',
    // This bucket controls snapshot/rebroadcast routing, not tab placement;
    // reuse it for the Subscriptions control because no subscriptions bucket exists.
    surfaces: { settingsView: 'agents', cliConfig: true },
    onWrite: { invalidatesModelOptions: true },
  },
  'xaiGrok.preferSubscription': {
    schema: z.boolean().prefault(false),
    description:
      'Prefer your signed-in Grok (xAI SuperGrok) account for xAI models instead of API-key routing. Experimental. Uses the public Grok CLI OAuth client; xAI may change or revoke that registration without notice.',
    onWrite: SUBSCRIPTION_PREFERENCE_WRITE,
  },
  maxImageDimension: {
    schema: z.int().min(100).max(10000).prefault(2000),
    description:
      'Maximum dimension (width or height) in pixels for images before resizing. Images larger than this will be resized to fit within this dimension while maintaining aspect ratio.',
  },
  // The launcher's commit picker reads the count through the host snapshot on
  // both GUI hosts; the CLI only writes it, through the setup assistant's
  // `update_config`.
  'git.numberOfCommitsToShow': {
    schema: z.int().min(1).max(1000).prefault(20),
    description:
      'Number of recent commits to show in the commit selection dropdown',
  },
  'audio.soxPath': {
    schema: z.string().prefault(''),
    description: 'Path to the SoX executable. Overrides automatic detection.',
  },
  'logger.debugMode': {
    schema: z.boolean().prefault(false),
    description:
      "Show the transcript's verbose tier: debug-level rows and their payload detail. The log surfaces filter themselves (the Output view's own level filter, the desktop log file, the CLI's --verbose/--quiet).",
  },
  'debug.saveModelIO': {
    schema: z.boolean().prefault(false),
    description:
      'Save what TeXRA sends to and receives from the model: the request messages and raw responses as JSON, plus the final input prompt as XML.',
  },
  'skills.enabled': {
    schema: AgentSkillsEnabledSchema.prefault(AGENT_SKILLS_ENABLED_DEFAULT),
    title: 'Enable skills for agents',
    description:
      'Expose enabled TeXRA and imported skills to agent prompts. Skills are off by default.',
    category: 'tools',
    surfaces: { settingsView: 'skills', cliConfig: true },
  },
  'toolUse.requireEditApproval': {
    schema: z.boolean().prefault(true),
    title: 'Require approval for file edits',
    description:
      'Show a diff and wait for your approval before an agent changes a project file.',
    category: 'tools',
    configTarget: 'local',
    surfaces: { settingsView: 'approval' },
  },
  'toolUse.requireBashApproval': {
    schema: z.boolean().prefault(true),
    title: 'Require approval for shell commands',
    description: 'Wait for your approval before an agent runs a shell command.',
    category: 'tools',
    configTarget: 'local',
    surfaces: { settingsView: 'approval' },
  },
};

/**
 * Config-file-backed rows from a record keyed by dotted path under `texra.`:
 * the key and the uniform `config` slot are derived, not restated. The
 * record's declaration order is the catalog order.
 */
export function configTreeRows(
  rows: Readonly<Record<string, Omit<StateSettingEntry, 'key' | 'slot'>>>,
): StateSettingEntry[] {
  return Object.entries(rows).map(([path, row]) => ({
    ...row,
    key: `texra.${path}`,
    slot: 'config',
  }));
}

/**
 * `texra.approvalPolicy`, written out beside the config tree because the
 * approval-policy module owns its schema and its legacy-spelling
 * normalization.
 */
const APPROVAL_POLICY_SETTING = surfacedSetting({
  key: TEXRA_APPROVAL_POLICY_CONFIG_KEY,
  // Strict on purpose: `settingEnumOptions` derives the dropdown from a
  // `ZodEnum` row, and the tolerant spelling belongs to
  // `parseTexraApprovalPolicy`, which every reader of typed-in text (the
  // env var, `--approval-policy`, `/approval`, the dropdown) calls before
  // a value ever reaches this row.
  schema: TexraApprovalPolicySchema.prefault(TEXRA_APPROVAL_POLICY_DEFAULT),
  title: 'Approval policy',
  description:
    'Whether agents ask before running shell commands and editing files. Under Ask, the toggles below choose which of the two need your approval.',
  category: 'tools',
  slot: 'config',
  configTarget: 'local',
  enumLabels: ['Block', 'Ask', 'Auto-approve'],
  surfaces: { settingsView: 'approval', cliConfig: true },
});

// ============================================================================
// State-backed rows
// ============================================================================

// Written by the extension/desktop Models tab and the CLI's `/config` panel
// through the same catalog write path.
const PROVIDER_ENDPOINT_SETTINGS = PROVIDER_ENDPOINT_STATE_ENTRIES.map(
  ({ endpointKey, displayName }) =>
    surfacedSetting({
      key: endpointKey,
      schema: z.string().prefault(''),
      title: `${displayName} endpoint`,
      description: `Custom base URL for ${displayName} API requests. Leave empty to use the default endpoint.`,
      category: 'model',
      slot: 'globalState',
      surfaces: { settingsView: 'profile', cliConfig: true },
    }),
);

/**
 * Region toggles resolved into `RouteFacts.endpoints`, each also a Models tab
 * control for its provider: one row per provider plugin `region`.
 */
const PROVIDER_ROUTING_SETTINGS = PROVIDER_REGION_SETTINGS.map(
  ({ provider, key, default: china, control }) =>
    globalProviderToggle({
      key,
      default: china,
      model: { provider, ...control },
    }),
);

const STATE_SETTINGS: readonly StateSettingEntry[] = [
  // --- Git commit author marking ---------------------------------------------
  surfacedSetting({
    key: WorkspaceStateKey.GIT_MARK_COMMITS,
    schema: z.boolean().prefault(true),
    title: 'Mark agent commits',
    description:
      'Attribute agent-authored git commits to the TeXRA identity so they are distinguishable from your own commits.',
    category: 'git',
    slot: 'repoState',
    surfaces: { settingsView: 'git-author', cliConfig: true },
  }),
  surfacedSetting({
    key: WorkspaceStateKey.GIT_AUTHOR_NAME,
    // `.min(1)` so a blank value is rejected at the write boundary and a
    // legacy blank read falls back (loudly) to the default identity.
    schema: z.string().min(1).prefault(DEFAULT_GIT_AUTHOR_NAME),
    title: 'Agent commit author',
    description:
      'Author and committer name used for agent-authored commits when commit marking is enabled.',
    category: 'git',
    slot: 'repoState',
    surfaces: { settingsView: 'git-author', cliConfig: true },
  }),
  surfacedSetting({
    key: WorkspaceStateKey.GIT_AUTHOR_EMAIL,
    schema: z.string().min(1).prefault(DEFAULT_GIT_AUTHOR_EMAIL),
    title: 'Agent commit email',
    description:
      'Author and committer email used for agent-authored commits when commit marking is enabled.',
    category: 'git',
    slot: 'repoState',
    surfaces: { settingsView: 'git-author', cliConfig: true },
  }),
  surfacedSetting({
    key: WorkspaceStateKey.GIT_WORKTREE_SUPPORT,
    schema: z.boolean().prefault(false),
    title: 'Subagent worktrees',
    description:
      'Allow spawned subagents to run in isolated git worktrees so parallel edits do not conflict.',
    category: 'git',
    slot: 'repoState',
    surfaces: { settingsView: 'git-author', cliConfig: true },
  }),

  // --- Workspace agents ----------------------------------------------------------
  // Written and read by the agent list and the settings view's agent catalog,
  // which no catalog-driven UI renders.
  {
    key: WorkspaceStateKey.WORKSPACE_AGENTS,
    schema: WorkspaceAgentsSelectionSchema.prefault(INHERITED_WORKSPACE_AGENTS),
    slot: 'repoState',
  },
  {
    key: WorkspaceStateKey.CUSTOM_TEAMS,
    schema: z.array(AgentModePresetSchema).prefault([]),
    slot: 'repoState',
  },
  {
    key: WorkspaceStateKey.HIDDEN_CUSTOM_AGENTS,
    schema: HiddenCustomAgentKeysSchema.prefault([]),
    slot: 'repoState',
  },

  // --- Agent coordination ---------------------------------------------
  // Both child-work policy toggles live in `globalState` per the 2026-08-15
  // maintainer ruling (2026-08-15-shared-contracts-and-retirement.md
  // §2.1): they describe how *this user* wants child runs handled, not anything
  // about a particular checkout, so no worktree-scoping need is documented on
  // either row. Before the move the extension smuggled that same intent past a
  // `workspaceState` slot via a worktree-shared key list, while the Node hosts
  // scoped the value per workspace-path hash — one row, two meanings.
  surfacedSetting({
    key: GlobalStateKey.ALLOW_ORCHESTRATOR_KILL,
    schema: z.boolean().prefault(true),
    title: 'Let a task stop its agents',
    description:
      'Allow a task to stop the agents it started once they are no longer needed.',
    category: 'agents',
    slot: 'globalState',
    surfaces: { settingsView: 'agents', cliConfig: true },
  }),
  surfacedSetting({
    key: GlobalStateKey.DETACH_SUBAGENTS_ON_STOP,
    schema: z.boolean().prefault(false),
    title: 'Keep agents running',
    description: "Let a task's agents continue when the task is stopped.",
    category: 'agents',
    slot: 'globalState',
    surfaces: { settingsView: 'agents', cliConfig: true },
  }),

  // --- Memory ---------------------------------------------------------------
  // Every host's runtime honors the key through the `memory` entry of the
  // memory-workflow plugin's `injectedWhen` (`@tools/plugins`), but only the
  // settings view renders it; the CLI has no `/config` row for it.
  surfacedSetting({
    key: GlobalStateKey.MEMORY_ENABLED,
    schema: z.boolean().prefault(true),
    title: 'Enable memory for chat agents',
    description: 'Remember useful details across chat sessions.',
    category: 'tools',
    slot: 'globalState',
    surfaces: { settingsView: 'memory' },
  }),

  // --- OpenAI WebSocket transport (experimental) -----------------------------
  surfacedSetting({
    key: GlobalStateKey.WEBSOCKET_OPENAI,
    schema: z.boolean().prefault(false),
    title: 'OpenAI WebSocket',
    description:
      'EXPERIMENTAL: use the persistent WebSocket transport for OpenAI Responses requests (lower latency for tool-use loops), and let the ChatGPT-subscription Codex backend attempt WebSocket. Off by default.',
    category: 'model',
    slot: 'globalState',
    surfaces: {
      settingsView: 'profile',
      cliConfig: true,
      models: [
        {
          provider: 'openai',
          label: 'WebSocket transport',
          description:
            'Use a persistent WebSocket connection for lower-latency tool-use loops. Requires direct OpenAI API (not compatible with custom endpoints).',
        },
      ],
    },
  }),

  // --- Provider endpoints -----------------------------------------------------
  ...PROVIDER_ENDPOINT_SETTINGS,

  // --- Model picker preferences ---------------------------------------------
  surfacedSetting({
    key: GlobalStateKey.HELPER_MODEL,
    schema: z.string().min(1).prefault(DEFAULT_HELPER_MODEL),
    title: 'Helper model',
    description:
      'Model used for auxiliary tasks: instruction polishing, merges, and session descriptions.',
    category: 'model',
    slot: 'globalState',
    surfaces: { settingsView: 'models' },
  }),
  surfacedSetting({
    key: GlobalStateKey.PREFER_SHORT_MODEL_NAMES,
    schema: z.boolean().prefault(false),
    title: 'Prefer short model names',
    description: 'Show compact model names in pickers.',
    category: 'model',
    slot: 'globalState',
    surfaces: { settingsView: 'models' },
  }),

  // --- OpenRouter routing ----------------------------------------------------
  globalProviderToggle({
    key: GlobalStateKey.USE_OPENROUTER,
    default: false,
    onWrite: { invalidatesModelOptions: true },
    model: {
      provider: 'openRouter',
      label: 'Use OpenRouter for all models',
      description:
        'Route all API calls through OpenRouter instead of direct provider APIs. Requires an OpenRouter API key; your OpenRouter key is always used directly.',
    },
  }),

  // --- Provider routing & region toggles --------------------------------------
  globalProviderToggle({
    key: GlobalStateKey.KIMI_CODE_PREFER,
    default: false,
    // Kimi Code and OpenRouter are alternative routes for the same dual-backend
    // models, so enabling one clears the other on every write path.
    onWrite: {
      disablesWhenEnabled: [GlobalStateKey.USE_OPENROUTER],
      invalidatesModelOptions: true,
    },
    model: {
      provider: 'kimiCode',
      label: 'Kimi Code subscription',
      description:
        'Route dual-backend Kimi models (K3) through the Kimi Code coding endpoint when a Kimi Code API key is set. The two coding-only models always use the key. When off, K3 uses the Moonshot open platform.',
    },
  }),
  ...PROVIDER_ROUTING_SETTINGS,
  globalProviderToggle({
    key: GlobalStateKey.GLM_CODING_PLAN,
    default: false,
    onWrite: { invalidatesModelOptions: true },
    model: {
      provider: 'glm',
      label: 'GLM Coding Plan',
      description:
        'Use a Coding Plan subscription key instead of pay-as-you-go. Routes requests through the coding-specific endpoint with monthly quota limits.',
      warningUrl: 'https://z.ai/subscribe',
      warningUrlLabel: 'Subscribe',
    },
  }),

  // --- Plugin switches ------------------------------------------------------
  // Written and read by the Plugins page and the TUI's `/plugins` over the
  // plugin rows, which no catalog-driven UI renders.
  {
    key: GlobalStateKey.DISABLED_TOOLS,
    schema: z.array(z.string()).prefault([]),
    slot: 'globalState',
  },
  surfacedSetting({
    key: WorkspaceStateKey.DISABLED_SKILLS,
    schema: z.array(QualifiedSkillNameSchema).prefault([]),
    title: 'Skills',
    description: 'Enable or disable individual skills in this workspace.',
    category: 'tools',
    slot: 'config',
    openForm: 'skills',
    surfaces: { settingsView: 'skills', cliConfig: true },
  }),
  surfacedSetting({
    key: WorkspaceStateKey.DISABLED_SKILL_SOURCES,
    schema: z.array(ActiveSkillSourceScopeSchema).prefault([]),
    title: 'Skill sources',
    description: 'Enable or disable skill source groups in this workspace.',
    category: 'tools',
    slot: 'config',
    openForm: 'skills',
    surfaces: { settingsView: 'skills', cliConfig: true },
  }),
  surfacedSetting({
    key: WorkspaceStateKey.TOOL_PATH_PROTECTION_ENABLED,
    schema: z.boolean().prefault(DEFAULT_TOOL_PATH_PROTECTION_ENABLED),
    title: 'Restrict tool paths to the working directory',
    description:
      'Keep file-reading, editing, search, diagnostics, and PDF tools inside the active working directory. Turn this off only when an agent must use arbitrary filesystem paths.',
    category: 'tools',
    slot: 'workspaceState',
    surfaces: { settingsView: 'approval', cliConfig: true },
  }),
];

// ============================================================================
// The catalog — the harness's rows followed by an app's; every list below is
// a filter over it, never hand-maintained
// ============================================================================

/** The harness's own rows, in catalog order: config-file-backed, then state-backed. */
const HARNESS_SETTINGS: readonly StateSettingEntry[] = [
  ...configTreeRows(HARNESS_CONFIG_ROWS),
  APPROVAL_POLICY_SETTING,
  ...STATE_SETTINGS,
];

function isSurfaced(entry: StateSettingEntry): entry is SurfacedSettingEntry {
  return (
    entry.surfaces !== undefined &&
    entry.description !== undefined &&
    entry.category !== undefined
  );
}

/** One settings catalog and the lookups every settings surface reads from it. */
export interface SettingsCatalog {
  /** Every row, in catalog order. */
  readonly rows: readonly StateSettingEntry[];
  /** Look up any row, config-file-backed or state-backed, by its key. */
  readonly byKey: (key: string) => StateSettingEntry | undefined;
  /** Look up a row the settings view's unified write path owns. */
  readonly settingsViewByKey: (
    key: string,
  ) => SettingsViewStateSettingEntry | undefined;
  /**
   * The rows one settings-view snapshot carries, in catalog order: the
   * outbound payload's Zod shape, the backend's read loop and the webview's
   * apply step each iterate this list, so adding
   * `surfaces.settingsView: '<snapshot>'` to a row puts it on the wire.
   */
  readonly snapshotEntries: (
    snapshot: SettingsViewSnapshot,
  ) => readonly SettingsViewStateSettingEntry[];
  /** The `/config` panel's rows: `surfaces.cliConfig` is the one predicate. */
  readonly cliRows: readonly SurfacedSettingEntry[];
  /** Look up a row the CLI `/config` panel lists, and so may write. */
  readonly cliByKey: (key: string) => SurfacedSettingEntry | undefined;
  /** Keys of the config-file-backed rows: the CLI's unknown-key whitelist's catalog half. */
  readonly configSlotKeys: readonly string[];
  /** The Models tab's controls for one provider, in catalog order. */
  readonly modelsTab: (provider: string) => readonly {
    readonly entry: StateSettingEntry;
    readonly surface: ModelsTabSurface;
  }[];
  /**
   * A fresh copy of a config-file-backed row's default, or `undefined` for a
   * key no such row owns: the step every `ConfigProvider` applies between the
   * stored value and the caller's fallback. Parsed defaults are memoized
   * because this is on the read path of every absent setting; object values
   * are cloned so a caller cannot mutate the catalog's own default.
   */
  readonly configDefault: (key: string) => unknown;
}

/**
 * The catalog of the harness's rows, then `appRows` (an app's own, its
 * plugins' included). A key declared twice is a defect and throws.
 */
export function settingsCatalog(
  appRows: readonly StateSettingEntry[],
): SettingsCatalog {
  const rows = [...HARNESS_SETTINGS, ...appRows];
  const byKey = new Map<string, StateSettingEntry>();
  for (const row of rows) {
    if (byKey.has(row.key)) {
      throw new Error(`Setting ${row.key} is declared twice.`);
    }
    byKey.set(row.key, row);
  }
  const surfaced = rows.filter(isSurfaced);
  const settingsView = new Map(
    surfaced
      .filter(
        (entry): entry is SettingsViewStateSettingEntry =>
          entry.surfaces.settingsView !== undefined,
      )
      .map((entry) => [entry.key, entry]),
  );
  const cliRows = surfaced.filter((entry) => entry.surfaces.cliConfig === true);
  const cliByKey = new Map(cliRows.map((entry) => [entry.key, entry]));
  const defaults = new Map<string, unknown>();
  return {
    rows,
    byKey: (key) => byKey.get(key),
    settingsViewByKey: (key) => settingsView.get(key),
    snapshotEntries: (snapshot) =>
      [...settingsView.values()].filter(
        (entry) => entry.surfaces.settingsView === snapshot,
      ),
    cliRows,
    cliByKey: (key) => cliByKey.get(key),
    configSlotKeys: rows
      .filter((entry) => entry.slot === 'config')
      .map((entry) => entry.key),
    modelsTab: (provider) =>
      rows.flatMap((entry) =>
        (entry.surfaces?.models ?? [])
          .filter((surface) => surface.provider === provider)
          .map((surface) => ({ entry, surface })),
      ),
    configDefault: (key) => {
      const canonicalKey = key.startsWith('texra.') ? key : `texra.${key}`;
      const entry = byKey.get(canonicalKey);
      if (entry?.slot !== 'config') return undefined;
      if (!defaults.has(canonicalKey)) {
        defaults.set(canonicalKey, entry.schema.parse(undefined));
      }
      const value = defaults.get(canonicalKey);
      return value !== null && typeof value === 'object'
        ? structuredClone(value)
        : value;
    },
  };
}

/**
 * The process's catalog: the harness's rows until `installProcessRuntime`
 * installs the app's rows beside them, once per process, as
 * it installs the session owner. The harness reads a setting by key through
 * it, so it never imports an app's rows.
 */
let installed = settingsCatalog([]);

/** Install the process's catalog; `installProcessRuntime` calls it once. */
export function installSettingsCatalog(catalog: SettingsCatalog): void {
  installed = catalog;
}

/** Look up any installed row by its key. */
export function settingByKey(key: string): StateSettingEntry | undefined {
  return installed.byKey(key);
}

/** An installed config-file-backed row's default (see `SettingsCatalog.configDefault`). */
export function getCoreSettingDefault(key: string): unknown {
  return installed.configDefault(key);
}

// ============================================================================
// Row helpers
// ============================================================================

/** The entry's schema with the outer `.prefault()` wrapper peeled off. */
export function settingSchemaWithoutPrefault(
  entry: StateSettingEntry,
): unknown {
  return entry.schema instanceof z.ZodPrefault
    ? entry.schema.unwrap()
    : entry.schema;
}

/**
 * Enum option values for a setting, derived from its `z.enum(...)` schema (via
 * the public `.unwrap().options`) rather than restated on the row, or
 * `undefined` for non-enum settings. The schema stays the single source of the
 * allowed values; only the per-value prose (`enumDescriptions`) is editorial.
 */
export function settingEnumOptions(
  entry: StateSettingEntry,
): readonly string[] | undefined {
  const inner = settingSchemaWithoutPrefault(entry);
  return inner instanceof z.ZodEnum
    ? (inner.options as readonly string[])
    : undefined;
}

export interface SettingEnumChoice<T extends string = string> {
  readonly value: T;
  readonly label: string;
  readonly description?: string;
}

/** Enum values paired with display metadata for settings UIs. */
export function settingEnumChoices<T extends string = string>(
  entry: StateSettingEntry,
): readonly SettingEnumChoice<T>[] | undefined {
  const values = settingEnumOptions(entry);
  if (!values) return undefined;
  return values.map((value, index) => ({
    value: value as T,
    label: entry.enumLabels?.[index] ?? value,
    ...(entry.enumDescriptions?.[index] && {
      description: entry.enumDescriptions[index],
    }),
  }));
}

/** Whether the setting uses a boolean edit affordance. */
export function settingIsBoolean(entry: StateSettingEntry): boolean {
  return settingSchemaWithoutPrefault(entry) instanceof z.ZodBoolean;
}

/** Whether the setting uses a free-text edit affordance. */
export function settingIsString(entry: StateSettingEntry): boolean {
  return settingSchemaWithoutPrefault(entry) instanceof z.ZodString;
}

/** Whether the setting uses a numeric edit affordance. */
export function settingIsNumber(entry: StateSettingEntry): boolean {
  return settingSchemaWithoutPrefault(entry) instanceof z.ZodNumber;
}
