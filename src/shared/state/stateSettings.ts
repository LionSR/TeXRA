// Third-party imports
import { z } from 'zod';

// Local imports - shared constants & state keys
import {
  TEXRA_APPROVAL_POLICY_CONFIG_KEY,
  TEXRA_APPROVAL_POLICY_DEFAULT,
  TexraApprovalPolicySchema,
} from '@shared/approvalPolicy';
import {
  LATEX_CONFIG_DEFAULTS,
  LATEX_CONFIG_RANGES,
  LATEX_FORMATTER_VALUES,
  LATEXDIFF_MATH_MARKUP_VALUES,
} from '@shared/constants/latexConfig';
import { MODEL_PROVIDER_PLUGINS } from '@shared/constants/modelProviderPlugins';
import {
  DEFAULT_HELPER_MODEL,
  PROVIDER_ENDPOINT_STATE_ENTRIES,
} from '@shared/constants/providers';
import {
  DEFAULT_ENABLED_REGEX_REPLACEMENTS,
  DEFAULT_ENABLED_REPLACEMENTS,
  NON_REGEX_REPLACEMENT_CATEGORIES,
  REGEX_REPLACEMENT_CATEGORIES,
} from '@shared/constants/replacementCategories';
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
  AGENT_CLI_EFFORT_SETTING,
  CLAUDE_AGENT_DEFAULT_PERMISSION_MODE,
  CLAUDE_AGENT_MODEL_SETTING,
  ClaudeAgentPermissionModeSchema,
  CliOutputFormatSchema,
  CODEX_APPROVAL_POLICY_DEFAULT,
  CODEX_MODEL_SETTING,
  CODEX_SANDBOX_MODE_DEFAULT,
  CodexApprovalPolicySchema,
  CodexSandboxModeSchema,
  GOAL_MAX_COST_SETTING,
  GoalMaxCostSchema,
  LATEXDIFF_TEMP_FILE_LOCATIONS,
  MODEL_COMPACTION_THRESHOLD_SETTING,
  MODEL_RETRY_MAX_ATTEMPTS_SETTING,
  ModelCompactionThresholdPercentSchema,
  ModelRetryMaxAttemptsSchema,
  INHERITED_WORKSPACE_AGENTS,
  QualifiedSkillNameSchema,
  TELEMETRY_ENABLED_DEFAULT,
} from '@shared/schemas';
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
 * Host-neutral catalog for every TeXRA setting a host can store or render.
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
const SETTING_HOSTS = ['vscode', 'cli', 'desktop', 'sdk'] as const;
export type SettingHost = (typeof SETTING_HOSTS)[number];

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

// ============================================================================
// Row builders
// ============================================================================

type SurfacedSettingInput = Omit<
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
function surfacedSetting(entry: SurfacedSettingInput): SurfacedSettingEntry {
  return entry;
}

/** An external coding agent's row: repo-scoped, on the approval tab and in `/config`. */
function agentCliSetting(
  entry: Omit<SurfacedSettingInput, 'category' | 'slot' | 'surfaces'>,
): SurfacedSettingEntry {
  return surfacedSetting({
    ...entry,
    category: 'ai-agents',
    slot: 'repoState',
    surfaces: { settingsView: 'approval', cliConfig: true },
  });
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

/** Standalone preamble used when extracting a TikZ figure for compilation. */
const DEFAULT_TIKZ_TEMPLATE =
  '\\documentclass[tikz,border=10pt]{standalone}\n' +
  '\\usepackage{tikz}\n' +
  '\\usepackage{pgfplots}\n' +
  '\\usetikzlibrary{positioning}\n' +
  '\\usetikzlibrary{patterns}\n' +
  '\\usetikzlibrary{arrows.meta, shapes.geometric, matrix, calc, decorations.pathreplacing}\n' +
  '\\usetikzlibrary{shapes, arrows}\n\n' +
  '\\begin{document}\n' +
  '{{ tikzpicture }}\n' +
  '\\end{document}';

// The terminal client's own `.texra/config.json` rows (`agent`, `model`,
// `chat`, `run`, `outputFormat`): which agent and model a command starts with,
// and how it prints. Only the CLI runtime reads them; the extension and desktop
// resolve an agent and a model from their own surfaces.

/** An agent key or name, as typed into `.texra/config.json`. */
const CliAgentSchema = z.string().trim().min(1).optional();

/** A model id, validated against the model registry where it is used. */
const CliModelSchema = z.string().trim().min(1).optional();

/** Per-command overrides of the top-level `agent`/`model` rows. */
const CliCommandDefaultsSchema = z
  .object({ agent: CliAgentSchema, model: CliModelSchema })
  .optional();

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
const CORE_SETTING_ROWS: Record<
  string,
  Omit<StateSettingEntry, 'key' | 'slot'>
> = {
  agent: {
    schema: CliAgentSchema,
    title: 'Default agent',
    description:
      'Agent `texra chat` and `texra run` start with when neither `--agent` nor a per-command default names one.',
  },
  model: {
    schema: CliModelSchema,
    title: 'Default model',
    description:
      'Model every `texra` command starts with when neither `--model`, `TEXRA_MODEL`, nor a per-command default names one. A model this machine cannot run falls back to an available one with a notice.',
  },
  chat: {
    schema: CliCommandDefaultsSchema,
    title: 'Chat defaults',
    description:
      'Agent and model `texra chat` starts with, overriding the top-level defaults.',
  },
  run: {
    schema: CliCommandDefaultsSchema,
    title: 'Run defaults',
    description:
      'Agent and model `texra run` starts with, overriding the top-level defaults.',
  },
  outputFormat: {
    schema: CliOutputFormatSchema,
    title: 'Output format',
    description:
      'How `texra` prints results: human text, one JSON object, or NDJSON records. `--output-format` and `TEXRA_OUTPUT_FORMAT` override it.',
  },
  'agentOutputs.autoOpenFinal': {
    schema: z.boolean().prefault(true),
    description:
      "When a workflow run completes, automatically preview the final revised file in a new editor tab. Disable for batch runs when you don't want a tab to steal focus.",
  },
  childRunConcurrencyBudget: {
    schema: ChildRunConcurrencyBudgetSchema,
    title: 'Child-run concurrency budget',
    description: CHILD_RUN_CONCURRENCY_BUDGET_SETTING.description,
    category: 'agents',
    surfaces: { settingsView: 'agents', cliConfig: true },
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
    'Keep long-running OpenAI requests alive in the background (polling) instead of timing out after 10 minutes. Applies automatically to GPT models running workflow agents; ignored otherwise. Disable to fall back to synchronous streaming requests.',
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
  'bib.defaultPath': {
    schema: z.string().prefault(''),
    description:
      'Default path to bibliography file (.bib). This is used by bibliography tools when no explicit path is provided. Supports Zotero auto-exported .bib files.',
  },
  'bib.zoteroPort': {
    schema: z.int().min(1).max(65535).prefault(23119),
    description:
      'Port number for Zotero integration (default: 23119). Used by both the Connector API and Better BibTeX JSON-RPC.',
  },
  'latex.latexindentConfig': {
    schema: z.string().prefault(''),
    description: 'Path to latexindent configuration file',
  },
  'latex.texfmtConfig': {
    schema: z.string().prefault(''),
    description: 'Path to tex-fmt configuration file',
  },
  'latex.tikzInputDirectory': {
    schema: z.string().prefault(''),
    description:
      'Directory where to look for extra input files when compiling extracted TikZ figures. Absolute path is required. Sets TEXINPUTS environment variable for TikZ compilation.',
  },
  'latex.includeWorkspaceInTexinputs': {
    schema: z.boolean().prefault(true),
    description:
      'Include the workspace root directory in TEXINPUTS when compiling TikZ figures',
  },
  'latex.tikzTemplate': {
    schema: z.string().prefault(DEFAULT_TIKZ_TEMPLATE),
    description:
      'Template used for generating standalone documents when extracting and compiling TikZ figures',
  },
  'latex.wrapCritiqueInAlign': {
    schema: z.boolean().prefault(true),
    title: 'Wrap criticism in align environments',
    description:
      'Wrap bare criticism and comment commands inside align environments with intertext.',
    category: 'latex',
  },
  'latex.enabledReplacements': {
    schema: z
      .array(z.enum(NON_REGEX_REPLACEMENT_CATEGORIES))
      .prefault(DEFAULT_ENABLED_REPLACEMENTS),
    title: 'Literal replacement groups',
    description: 'Enabled groups of direct LaTeX cleanup replacements.',
    category: 'latex',
  },
  'latex.enabledReplacementsRegex': {
    schema: z
      .array(z.enum(REGEX_REPLACEMENT_CATEGORIES))
      .prefault(DEFAULT_ENABLED_REGEX_REPLACEMENTS),
    title: 'Pattern replacement groups',
    description: 'Enabled groups of pattern-based LaTeX cleanup replacements.',
    category: 'latex',
  },
  'latex.customReplacementsRegex': {
    schema: z.record(z.string(), z.string()).prefault({}),
    title: 'Custom pattern replacements',
    description: 'Custom regular-expression replacements.',
    category: 'latex',
  },
  'latex.customReplacements': {
    schema: z.record(z.string(), z.string()).prefault({}),
    title: 'Custom literal replacements',
    description: 'Custom direct text replacements.',
    category: 'latex',
  },
  'latexdiff.tempFileLocation': {
    schema: z.enum(LATEXDIFF_TEMP_FILE_LOCATIONS).prefault('sameDirectory'),
    description:
      'Where to create temporary files for LaTeX preview and diff operations during tool edit approval.',
    enumDescriptions: [
      'Create temp files in the same directory as the original file. Best for resolving \\input{} and relative paths.',
      'Create temp files in .texra-temp directory at workspace root. Keeps source directories clean but may break relative paths.',
    ],
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
  'telemetry.enabled': {
    schema: z.boolean().prefault(TELEMETRY_ENABLED_DEFAULT),
    title: 'Share usage telemetry',
    description:
      'Send anonymous model, agent, token, timing, and host metadata with a random install ID (no account). TeXRA never sends prompt text, document content, or file names. Turning this off stops all reporting.',
    category: 'privacy',
    configTarget: 'global',
    projectMayOptOut: true,
    surfaces: { settingsView: 'telemetry' },
  },
  'debug.saveModelIO': {
    schema: z.boolean().prefault(false),
    description:
      'Save what TeXRA sends to and receives from the model: the request messages and raw responses as JSON, plus the final input prompt as XML.',
  },
  'skills.enabled': {
    schema: AgentSkillsEnabledSchema.prefault(AGENT_SKILLS_ENABLED_DEFAULT),
    title: 'Enable skills for tool-use agents',
    description:
      'Expose enabled TeXRA and imported skills to tool-use agent prompts. Skills are off by default.',
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

/** The config-file-backed rows, with their derived key and uniform slot. */
const CORE_TREE_SETTINGS: readonly StateSettingEntry[] = Object.entries(
  CORE_SETTING_ROWS,
).map(([path, row]) => ({
  ...row,
  key: `texra.${path}`,
  slot: 'config',
}));

const CORE_TREE_SETTINGS_BY_KEY: ReadonlyMap<string, StateSettingEntry> =
  new Map(CORE_TREE_SETTINGS.map((entry) => [entry.key, entry]));

const coreSettingDefaults = new Map<string, unknown>();

/**
 * Return a fresh copy of a config-tree setting's catalog-owned default, or
 * `undefined` for a key the config tree does not own.
 *
 * This is the resolution step every `ConfigProvider` applies between the stored
 * value and the caller's fallback, so a cataloged key needs no per-call-site
 * default. Parsed defaults are memoized because this sits on the read path of
 * every absent setting; object values are cloned so a caller cannot mutate the
 * catalog's own default.
 */
export function getCoreSettingDefault(key: string): unknown {
  const canonicalKey = key.startsWith('texra.') ? key : `texra.${key}`;
  const entry = CORE_TREE_SETTINGS_BY_KEY.get(canonicalKey);
  if (!entry) return undefined;
  if (!coreSettingDefaults.has(canonicalKey)) {
    coreSettingDefaults.set(canonicalKey, entry.schema.parse(undefined));
  }
  const value = coreSettingDefaults.get(canonicalKey);
  return value !== null && typeof value === 'object'
    ? structuredClone(value)
    : value;
}

/**
 * Config-file-backed rows: the config-tree rows above plus
 * `texra.approvalPolicy`, which stays hand-written because the approval-policy
 * module owns its schema and its legacy-spelling normalization.
 */
const CORE_SETTINGS: readonly StateSettingEntry[] = [
  ...CORE_TREE_SETTINGS,
  surfacedSetting({
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
  }),
];

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
 * Region toggles resolved by `@model/routeEndpoint`, each also a Models tab
 * control for its provider: one row per provider plugin `region`.
 */
const PROVIDER_ROUTING_SETTINGS = MODEL_PROVIDER_PLUGINS.flatMap(
  ({ id: provider, region }) =>
    region === undefined
      ? []
      : [
          globalProviderToggle({
            key: region.key,
            default: region.default,
            model: { provider, ...region.control },
          }),
        ],
);

export const STATE_SETTINGS: readonly StateSettingEntry[] = [
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
    title: 'Allow orchestrator cancellation',
    description:
      'Allow the orchestrator to stop subagents that are no longer needed.',
    category: 'agents',
    slot: 'globalState',
    surfaces: { settingsView: 'agents', cliConfig: true },
  }),
  surfacedSetting({
    key: GlobalStateKey.DETACH_SUBAGENTS_ON_STOP,
    schema: z.boolean().prefault(false),
    title: 'Keep subagents running',
    description:
      'Let active subagents continue when the orchestrator is stopped.',
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

  // --- External coding agent controls ---------------------------------------
  agentCliSetting({
    key: WorkspaceStateKey.CODEX_MODEL,
    ...CODEX_MODEL_SETTING,
    title: 'Codex model',
    description: 'OpenAI model selected for Codex agent sessions.',
  }),
  agentCliSetting({
    key: WorkspaceStateKey.CODEX_SANDBOX_MODE,
    schema: CodexSandboxModeSchema.prefault(CODEX_SANDBOX_MODE_DEFAULT),
    title: 'Codex sandbox mode',
    description: 'Filesystem access mode used when TeXRA launches Codex.',
    enumLabels: ['Read-only', 'Workspace write', 'Full access'],
  }),
  agentCliSetting({
    key: WorkspaceStateKey.CODEX_REASONING_EFFORT,
    ...AGENT_CLI_EFFORT_SETTING,
    title: 'Codex reasoning effort',
    description: 'Reasoning effort for Codex runs, up to what the model takes.',
  }),
  agentCliSetting({
    key: WorkspaceStateKey.CODEX_APPROVAL_POLICY,
    schema: CodexApprovalPolicySchema.prefault(CODEX_APPROVAL_POLICY_DEFAULT),
    title: 'Codex approval policy',
    description: 'When Codex should ask for approval before risky actions.',
    enumLabels: [
      'Auto approve',
      'Ask when requested',
      'Ask for untrusted',
      'Ask on failure',
    ],
  }),
  agentCliSetting({
    key: WorkspaceStateKey.CLAUDE_AGENT_MODEL,
    ...CLAUDE_AGENT_MODEL_SETTING,
    title: 'Claude Code model',
    description: 'Claude model selected for Claude Code agent sessions.',
  }),
  agentCliSetting({
    key: WorkspaceStateKey.CLAUDE_AGENT_PERMISSION_MODE,
    schema: ClaudeAgentPermissionModeSchema.prefault(
      CLAUDE_AGENT_DEFAULT_PERMISSION_MODE,
    ),
    title: 'Claude Code permission mode',
    description: 'Permission policy used by Claude Code agent sessions.',
    enumLabels: [
      'Prompt for risky actions',
      'Auto-accept edits',
      'Bypass all (dangerous)',
      'Plan only (read-only)',
    ],
  }),
  agentCliSetting({
    key: WorkspaceStateKey.CLAUDE_AGENT_EFFORT,
    ...AGENT_CLI_EFFORT_SETTING,
    title: 'Claude Code reasoning effort',
    description:
      'Reasoning effort for Claude Code, up to what the model takes.',
  }),

  // --- Workflow auto-compile -------------------------------------------------
  surfacedSetting({
    key: WorkspaceStateKey.WORKFLOW_AUTO_COMPILE,
    schema: z.boolean().prefault(LATEX_CONFIG_DEFAULTS.workflowAutoCompile),
    title: 'Auto-compile outputs',
    description:
      'Compile the LaTeX project automatically after an agent writes its output.',
    category: 'workflow',
    slot: 'workspaceState',
    surfaces: { settingsView: 'latex', cliConfig: true },
  }),
  surfacedSetting({
    key: WorkspaceStateKey.WORKFLOW_AUTO_COMPILE_TIMEOUT_MS,
    schema: z
      .int()
      .min(LATEX_CONFIG_RANGES.workflowAutoCompileTimeoutMs.min)
      .prefault(LATEX_CONFIG_DEFAULTS.workflowAutoCompileTimeoutMs),
    title: 'Auto-compile timeout',
    description:
      'Maximum time (in milliseconds) to wait for an automatic post-output compile before giving up.',
    category: 'workflow',
    slot: 'workspaceState',
    surfaces: { cliConfig: true },
  }),
  surfacedSetting({
    key: WorkspaceStateKey.WORKFLOW_AUTO_OPEN_PDF,
    schema: z.boolean().prefault(LATEX_CONFIG_DEFAULTS.workflowAutoOpenPdf),
    title: 'Open the compiled PDF',
    description:
      'After auto-compile, open the PDF when it succeeds or the LaTeX log when it fails.',
    category: 'workflow',
    slot: 'workspaceState',
    // Read by the documents plugin, but the emitted `requestOpenFile` has no
    // CLI handler (headless), so the CLI ignores it.
    surfaces: { settingsView: 'latex' },
  }),
  surfacedSetting({
    key: WorkspaceStateKey.WORKFLOW_REJECT_ON_COMPILE_FAILURE,
    schema: z
      .boolean()
      .prefault(LATEX_CONFIG_DEFAULTS.workflowRejectOnCompileFailure),
    title: 'Repair failed compiles',
    description:
      'When the automatic compile fails, spend the next planned round repairing the output from the compile log.',
    category: 'workflow',
    slot: 'workspaceState',
    surfaces: { settingsView: 'latex', cliConfig: true },
  }),

  // --- LaTeXdiff -------------------------------------------------------------
  // Run by the documents plugin, so every host honors them. The timeout is
  // kept out of the settings view (an insider knob) and edited from CLI
  // `/config`; the rest are deferred from `/config` by product decision.
  surfacedSetting({
    key: WorkspaceStateKey.LATEXDIFF_BETWEEN_ROUNDS,
    schema: z.boolean().prefault(LATEX_CONFIG_DEFAULTS.latexdiffBetweenRounds),
    title: 'Diff consecutive rounds',
    description:
      'Also diff each agent round against the previous one, not only against your original input.',
    category: 'latexdiff',
    slot: 'workspaceState',
    surfaces: { settingsView: 'latex' },
  }),
  surfacedSetting({
    key: WorkspaceStateKey.LATEXDIFF_TIMEOUT_MS,
    schema: z
      .int()
      .min(LATEX_CONFIG_RANGES.latexdiffTimeoutMs.min)
      .max(LATEX_CONFIG_RANGES.latexdiffTimeoutMs.max)
      .prefault(LATEX_CONFIG_DEFAULTS.latexdiffTimeoutMs),
    title: 'latexdiff timeout',
    description:
      'Maximum time (in milliseconds) to allow a single latexdiff invocation to run.',
    category: 'latexdiff',
    slot: 'workspaceState',
    surfaces: { cliConfig: true },
  }),
  surfacedSetting({
    key: WorkspaceStateKey.LATEXDIFF_MATH_MARKUP,
    schema: z
      .enum(LATEXDIFF_MATH_MARKUP_VALUES)
      .prefault(LATEX_CONFIG_DEFAULTS.latexdiffMathMarkup),
    title: 'Math markup in diffs',
    description: 'How latexdiff marks up changes inside math environments.',
    category: 'latexdiff',
    slot: 'workspaceState',
    enumDescriptions: [
      'suppress markup',
      'equation-level',
      'within equations',
      'small changes inside equations',
    ],
    surfaces: { settingsView: 'latex' },
  }),
  surfacedSetting({
    key: WorkspaceStateKey.LATEXDIFF_CHANGES_ONLY,
    schema: z.boolean().prefault(LATEX_CONFIG_DEFAULTS.latexdiffChangesOnly),
    title: 'Only changed pages in diff PDFs',
    description:
      'Compile diff PDFs with only the pages that contain edits, instead of the full document.',
    category: 'latexdiff',
    slot: 'workspaceState',
    surfaces: { settingsView: 'latex' },
  }),

  // --- LaTeX formatter -------------------------------------------------------
  surfacedSetting({
    key: WorkspaceStateKey.LATEX_FORMATTER,
    schema: z
      .enum(LATEX_FORMATTER_VALUES)
      .prefault(LATEX_CONFIG_DEFAULTS.latexFormatter),
    title: 'LaTeX formatter',
    description: 'Which formatter to run when formatting LaTeX source.',
    category: 'latex',
    slot: 'workspaceState',
    enumLabels: ['latexindent', 'tex-fmt', 'None'],
    enumDescriptions: [
      'needs Perl',
      'standalone Rust binary',
      'leave formatting unchanged',
    ],
    surfaces: { settingsView: 'latex' },
  }),

  // --- Inline criticism -------------------------------------------------------
  // Editor squiggles and Problems-panel entries exist only in VS Code. The
  // shared LaTeX snapshot reads the row on every host; the desktop LaTeX page
  // hides it.
  surfacedSetting({
    key: GlobalStateKey.INLINE_CRITICISM_ENABLED,
    schema: z.boolean().prefault(false),
    title: 'Show criticism as editor diagnostics',
    description:
      'Show \\criticize{message}{severity}{confidence} annotations from agent-revised LaTeX files as squiggles and Problems-panel entries.',
    category: 'latex',
    slot: 'globalState',
    surfaces: { settingsView: 'latex' },
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
// Derived views — every list below is a filter, never hand-maintained
// ============================================================================

/** Every catalog row, config-tree and state-backed. */
const ALL_SETTINGS: readonly StateSettingEntry[] = [
  ...CORE_SETTINGS,
  ...STATE_SETTINGS,
];

const SETTINGS_BY_KEY: ReadonlyMap<string, StateSettingEntry> = new Map(
  ALL_SETTINGS.map((entry) => [entry.key, entry]),
);

function isSurfaced(entry: StateSettingEntry): entry is SurfacedSettingEntry {
  return (
    entry.surfaces !== undefined &&
    entry.description !== undefined &&
    entry.category !== undefined
  );
}

const SURFACED_SETTINGS: readonly SurfacedSettingEntry[] =
  ALL_SETTINGS.filter(isSurfaced);

const SETTINGS_VIEW_SETTINGS_BY_KEY: ReadonlyMap<
  string,
  SettingsViewStateSettingEntry
> = new Map(
  SURFACED_SETTINGS.filter(
    (entry): entry is SettingsViewStateSettingEntry =>
      entry.surfaces.settingsView !== undefined,
  ).map((entry) => [entry.key, entry]),
);

/** Look up any catalog entry — config-tree or state-backed — by its key. */
export function settingByKey(key: string): StateSettingEntry | undefined {
  return SETTINGS_BY_KEY.get(key);
}

/** Look up a scalar setting owned by the settings view's unified write path. */
export function settingsViewSettingByKey(
  key: string,
): SettingsViewStateSettingEntry | undefined {
  return SETTINGS_VIEW_SETTINGS_BY_KEY.get(key);
}

/**
 * The rows one settings-view snapshot carries, in catalog order.
 *
 * This is the whole content of a catalog-derived snapshot: the outbound
 * payload's Zod shape, the backend's read loop, and the webview's apply step
 * each iterate this list instead of re-listing the same fields by hand. Adding
 * `surfaces.settingsView: '<snapshot>'` to a row is therefore all it takes to
 * put that setting on the wire.
 */
export function settingsViewSnapshotEntries(
  snapshot: SettingsViewSnapshot,
): readonly SettingsViewStateSettingEntry[] {
  return [...SETTINGS_VIEW_SETTINGS_BY_KEY.values()].filter(
    (entry) => entry.surfaces.settingsView === snapshot,
  );
}

/**
 * The `/config` catalog: every row the CLI panel renders, across both catalog
 * tiers. `surfaces.cliConfig` is the single predicate.
 */
export const CLI_STATE_SETTINGS: readonly SurfacedSettingEntry[] =
  SURFACED_SETTINGS.filter((entry) => entry.surfaces.cliConfig === true);

const CLI_STATE_SETTINGS_BY_KEY: ReadonlyMap<string, SurfacedSettingEntry> =
  new Map(CLI_STATE_SETTINGS.map((entry) => [entry.key, entry]));

/** Look up a row the CLI `/config` panel lists, and so may write. */
export function cliConfigSettingByKey(
  key: string,
): SurfacedSettingEntry | undefined {
  return CLI_STATE_SETTINGS_BY_KEY.get(key);
}

/**
 * Canonical `texra.*` keys of the config-backed rows — the CLI's unknown-key
 * whitelist's catalog half.
 */
export const CLI_CONFIG_SLOT_KEYS: readonly string[] = ALL_SETTINGS.filter(
  (entry) => entry.slot === 'config',
).map((entry) => entry.key);

/** Models tab controls for one provider, in catalog order. */
export function modelsTabSettings(provider: string): readonly {
  readonly entry: StateSettingEntry;
  readonly surface: ModelsTabSurface;
}[] {
  return ALL_SETTINGS.flatMap((entry) =>
    (entry.surfaces?.models ?? [])
      .filter((surface) => surface.provider === provider)
      .map((surface) => ({ entry, surface })),
  );
}

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
