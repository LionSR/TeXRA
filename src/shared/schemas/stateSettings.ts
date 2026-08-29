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
import {
  DEFAULT_HELPER_MODEL,
  PROVIDER_ENDPOINT_STATE_ENTRIES,
  PROVIDER_STATE_ENTRIES,
} from '@shared/constants/providers';
import {
  CLAUDE_AGENT_DEFAULT_EFFORT,
  CLAUDE_AGENT_DEFAULT_MODEL,
  CLAUDE_AGENT_DEFAULT_PERMISSION_MODE,
  ClaudeAgentEffortSchema,
  ClaudeAgentModelSchema,
  ClaudeAgentPermissionModeSchema,
  parseClaudeAgentModel,
  CODEX_APPROVAL_POLICY_DEFAULT,
  CODEX_REASONING_EFFORT_DEFAULT,
  CODEX_SANDBOX_MODE_DEFAULT,
  CodexApprovalPolicySchema,
  CodexReasoningEffortSchema,
  CodexSandboxModeSchema,
} from '@shared/schemas/agentCliSettings';
import {
  CHATGPT_CODEX_CONTEXT_WINDOW_SETTING,
  CHILD_RUN_CONCURRENCY_BUDGET_SETTING,
  ChatgptCodexContextWindowSchema,
  ChildRunConcurrencyBudgetSchema,
  LATEXDIFF_TEMP_FILE_LOCATIONS,
  MODEL_COMPACTION_THRESHOLD_SETTING,
  MODEL_RETRY_MAX_ATTEMPTS_SETTING,
  ModelCompactionThresholdPercentSchema,
  ModelRetryMaxAttemptsSchema,
  TELEMETRY_ENABLED_DEFAULT,
} from '@shared/schemas/coreSettings';
import {
  DEFAULT_ENABLED_REGEX_REPLACEMENTS,
  DEFAULT_ENABLED_REPLACEMENTS,
  NON_REGEX_REPLACEMENT_CATEGORIES,
  REGEX_REPLACEMENT_CATEGORIES,
} from '@shared/constants/replacementCategories';
import {
  AGENT_SKILLS_ENABLED_DEFAULT,
  AgentSkillsEnabledSchema,
} from '@shared/schemas/agentSkills';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';

// ============================================================================
// Git defaults
// ============================================================================

export const DEFAULT_GIT_AUTHOR_NAME = 'texra-ai';
export const DEFAULT_GIT_AUTHOR_EMAIL = 'texra-ai@users.noreply.github.com';

/**
 * Default for `texra.git.markCommits` when the workspace has never
 * toggled the setting. Shared by the backend reader
 * (`readGitAuthorSettings`) and the frontend signal initializer
 * (`SettingsApp.gitMarkCommits`) so the Git tab doesn't flash the
 * wrong state on first paint before settings arrive.
 */
export const DEFAULT_GIT_MARK_COMMITS = true;

/**
 * Default for `texra.git.worktreeSupport` when the workspace has never toggled
 * it. Shared by the backend reader (`readGitAuthorSettingsFromState`) and the
 * state-settings catalog so the default lives in one place.
 */
export const DEFAULT_GIT_WORKTREE_SUPPORT = false;

/**
 * Keep file-oriented tools inside the active working directory unless the
 * user explicitly grants them access to arbitrary filesystem paths.
 */
export const DEFAULT_TOOL_PATH_PROTECTION_ENABLED = true;

// ============================================================================
// The one setting row
// ============================================================================

/**
 * Host-neutral catalog for every TeXRA setting a host can store, honor, or
 * render.
 *
 * One row carries the catalog facts that used to be answered in six places:
 *
 * - **`slots`** — where each host stores the value (`config` /
 *   `workspaceState` / `globalState`). Replaces the old `store` + `cliStore`
 *   pair and the caller-chosen slot in `readGitAuthorSettingsFromState`.
 * - **`honoredBy`** — whose *runtime* actually reads the key, with the reading
 *   file as evidence. Replaces `CLI_CORE_SETTING_PATHS`,
 *   `EXTENSION_ONLY_CORE_SETTING_PATHS`, and the reader-file registry that
 *   used to live in the guardrail suite as a third copy of the same knowledge.
 * - **`writtenBy`** — exceptional host write evidence when a host must recognize
 *   a config key that its runtime does not honor. This is not an exhaustive
 *   writer catalog.
 * - **`surfaces`** — which catalog-driven *UI* renders the row (settings view,
 *   CLI `/config`, the Models tab's per-provider controls). Replaces the
 *   display half of the old `hosts` field, `settingsViewSnapshot`, and the
 *   Models tab's own `PROVIDER_SETTINGS` catalog.
 * - **`onWrite`** — write-time consequences declared once, so the CLI form and
 *   the webview Models tab cannot enforce different rules (the Kimi Code /
 *   OpenRouter mutual exclusion used to exist on one path only).
 *
 * Everything downstream is a filter over these rows: the CLI unknown-key set,
 * the `/config` panel, the settings-view write gate, the Models tab rows, and
 * `settingSlot(entry, host)`.
 */

/** Hosts that may store, honor, or surface a setting. */
export type SettingHost = 'vscode' | 'cli' | 'desktop';

/** Storage slot a setting is read from / written to. */
export type SettingStore = 'config' | 'workspaceState' | 'globalState';

/** Storage slot per host. Absent means the host does not store the key. */
type SettingSlots = {
  readonly [H in SettingHost]?: SettingStore;
};

export type SettingsViewSnapshot =
  | 'agent-skills'
  | 'approval'
  | 'git-author'
  | 'latex'
  | 'memory'
  | 'models'
  | 'multi-agent'
  | 'profile'
  | 'telemetry';

interface CliRuntimeReachability {
  /**
   * Representative CLI command that reaches this setting after it has been set.
   * Placeholders are allowed when the command needs an installed agent/model.
   */
  readonly command: string;
  /**
   * Short manual trace from the CLI command surface to the honoring reader.
   * This is a review checklist item, not executable wiring.
   */
  readonly through: string;
}

/** Evidence that one host's runtime honors a setting. */
interface SettingHonor {
  /**
   * Repo-relative source file that reads the setting in this host's runtime.
   * Checked for existence by the guardrail suite, so a row can never claim a
   * host honors a key by naming a file that does not exist.
   */
  readonly reader: string;
  /**
   * Runtime-reachability trace. Required by the guardrail suite whenever the
   * row is also surfaced in the CLI `/config` panel, so an editable row is
   * never a silent no-op.
   */
  readonly reachability?: CliRuntimeReachability;
}

/** Which hosts' runtimes honor the setting, and how that is known. */
type SettingHonoredBy = {
  readonly [H in SettingHost]?: SettingHonor;
};

/** Evidence for an exceptional host write to a setting it does not honor. */
interface SettingWriter {
  readonly writer: string;
}

type SettingWrittenBy = {
  readonly [H in SettingHost]?: SettingWriter;
};

/** One provider's control group in the Models tab. */
export interface ModelsTabSurface {
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
  /**
   * Optional normalization for legacy persisted values before schema validation.
   * Keep migration mappings in the domain parser referenced here, not the row.
   */
  readonly normalizePersisted?: (raw: unknown) => unknown;
  /** Short label for compact settings UIs; falls back to the stripped key. */
  readonly title?: string;
  /** Human-readable description, shared across every host that renders it. */
  readonly description?: string;
  /** Grouping label for settings UIs. Required once a UI renders the row. */
  readonly category?: string;
  /** Where each host stores the value. */
  readonly slots: SettingSlots;
  /** Persistence target for config-backed settings; workspace when omitted. */
  readonly configTarget?: 'global' | 'workspace';
  /** Which hosts' runtimes read the value, with the reading file as evidence. */
  readonly honoredBy: SettingHonoredBy;
  /**
   * Exceptional host writes that require config-key recognition even though
   * that host's runtime does not honor the value. Not an exhaustive writer list.
   */
  readonly writtenBy?: SettingWrittenBy;
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

/** Every host stores the setting in the same slot. */
function sameSlot(store: SettingStore): SettingSlots {
  return { vscode: store, cli: store, desktop: store };
}

/**
 * Every host's runtime reads the setting through one host-neutral module in
 * `src/`, so all three honor it. `cliReachability` is supplied when the row is
 * also editable in `/config`.
 */
function everyHost(
  reader: string,
  cliReachability?: CliRuntimeReachability,
): SettingHonoredBy {
  return {
    vscode: { reader },
    desktop: { reader },
    cli: cliReachability
      ? { reader, reachability: cliReachability }
      : { reader },
  };
}

/**
 * Only the webview hosts honor the setting — the reader exists in shared code
 * but its effect has no headless counterpart. The row must say why.
 */
function webviewHosts(reader: string): SettingHonoredBy {
  return { vscode: { reader }, desktop: { reader } };
}

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

/**
 * A Models-tab provider toggle: a globally-stored boolean that renders both as
 * a profile row and as one per-provider control on the Models tab. These rows
 * differ only in their default, copy, honoring reader, and Models-tab control,
 * so the uniform `configTarget: 'global'` / `category: 'model'` /
 * `settingsView: 'profile'` framing is written once here — the same tabulation
 * the region toggles already use through `PROVIDER_ROUTING_SETTINGS`. Returns a
 * `CORE_SETTING_ROWS` body (key and slot are added by the config-tree mapping).
 */
function modelProviderToggle(opts: {
  readonly default: boolean;
  readonly title: string;
  readonly description: string;
  readonly honoredBy: SettingHonoredBy;
  readonly model: ModelsTabSurface;
}): Omit<StateSettingEntry, 'key' | 'slots'> {
  return {
    schema: z.boolean().prefault(opts.default),
    configTarget: 'global',
    title: opts.title,
    description: opts.description,
    category: 'model',
    honoredBy: opts.honoredBy,
    surfaces: { settingsView: 'profile', models: [opts.model] },
  };
}

// ============================================================================
// Core (config-tree) rows
// ============================================================================

const REPLACEMENT_ENGINE_READER = 'src/replacement/engine.ts';

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

/**
 * Every config-file-backed setting, keyed by its dotted path under `texra.`.
 *
 * All three hosts read `.texra/config.json` and that storage is flat, so the
 * key and the slot are derived rather than restated; a row carries the schema
 * (with its `.prefault()` default), the copy, who honors it, and which UI
 * renders it — exactly the shape every state-backed row below already uses.
 *
 * The record's own declaration order is the catalog order, including the
 * Models tab's control order: reordering these keys reorders that UI.
 */
const CORE_SETTING_ROWS: Record<
  string,
  Omit<StateSettingEntry, 'key' | 'slots'>
> = {
  'agentOutputs.autoOpenFinal': {
    schema: z.boolean().prefault(true),
    description:
      "When a workflow run completes, automatically preview the final revised file in a new editor tab. Disable for batch runs when you don't want a tab to steal focus.",
    honoredBy: everyHost('src/agent/runtime/selectAutoOpenFinalOutput.ts'),
  },
  childRunConcurrencyBudget: {
    schema: ChildRunConcurrencyBudgetSchema,
    title: 'Child-run concurrency budget',
    description: CHILD_RUN_CONCURRENCY_BUDGET_SETTING.description,
    category: 'multi-agent',
    honoredBy: everyHost('src/agent/runtime/childRunBudget.ts', {
      command:
        'texra agents run <tool-use-agent> --instruction "dispatch two subagents"',
      through:
        'packages/cli/src/commands/agentsRun.ts -> packages/cli/src/runtime/runExecution.ts -> src/tools/delegation/detachedChildRun.ts -> src/agent/runtime/childRunLoop.ts -> src/agent/runtime/childRunBudget.ts',
    }),
    surfaces: { settingsView: 'multi-agent', cliConfig: true },
  },
  'goal.enabled': {
    schema: z.boolean().prefault(true),
    description:
      'Enable Goal, a per-stream autonomous-continuation mode for tool-use agents. When on, an active Goal lets the agent keep working across turns toward a stated objective until it calls plan(command="complete"). On by default; set to false to require manual continuation.',
    honoredBy: everyHost('src/tools/goal/goalFeatureFlag.ts'),
  },
  // The Models-tab provider toggles below are `configTarget: 'global'`:
  // they describe how you talk to a provider, not a property of one project,
  // and that is the scope they were written at before the catalog collapse
  // routed them through the shared write path. The target restores global
  // writes and exempts them from the extension's open-workspace write guard,
  // while Models-tab and runtime reads both keep merged-config semantics. A
  // workspace override therefore remains visible and honored; cleanup of values
  // stranded by the regression window is tracked separately in #11173.
  'model.gpt5ReasoningSummary': modelProviderToggle({
    default: false,
    title: 'GPT-5 reasoning summary',
    description:
      "Show the model's reasoning steps alongside its output when using GPT-5 models. Requires an OpenAI account with access to reasoning features.",
    honoredBy: everyHost(
      'src/agent/modelHandlers/openai/modelHandlerOpenAIResponse.ts',
    ),
    model: {
      provider: 'openai',
      label: 'GPT-5 reasoning summary',
      description:
        'Request reasoning summaries from GPT-5 models. Only available on OpenAI API Tier 3+.',
      warning:
        'New accounts with $20 credit are typically Tier 1 and will hit rate limits.',
      warningUrl:
        'https://platform.openai.com/settings/organization/billing/overview',
      warningUrlLabel: 'Check your tier',
    },
  }),
  'model.useOpenAIResponsesAPI': modelProviderToggle({
    default: true,
    title: 'Use the Responses API',
    description:
      "Use OpenAI's newer Responses API for additional features like built-in tool use. Disable to fall back to the classic Chat Completions API.",
    honoredBy: everyHost('src/agent/runtime/ModelFactory.ts'),
    model: {
      provider: 'openai',
      label: 'Use the Responses API',
      description:
        'Use the OpenAI Responses API instead of Chat Completions when available.',
    },
  }),
  'model.useGoogleInteractionsServerState': modelProviderToggle({
    default: true,
    title: 'Server-side conversation state',
    description:
      "Store Google Interactions conversation state on Google's servers via previous_interaction_id chaining, sending only the new turn each round. Google then retains the conversation for a limited period to enable chaining. Enabled by default. Disable to keep conversations off Google's servers — stateless mode resends the full transcript each round (store:false).",
    honoredBy: everyHost(
      'src/agent/modelHandlers/google/modelHandlerGoogleInteractions.ts',
    ),
    model: {
      provider: 'google',
      label: 'Server-side conversation state',
      description:
        "Store Interactions conversation state on Google's servers (send only the new turn each round; Google retains the conversation for a limited period to enable chaining). Disable to keep conversations off Google's servers and resend the full transcript each round.",
    },
  }),
  'model.useGoogleBackgroundResponses': modelProviderToggle({
    default: false,
    title: 'Google background responses',
    description:
      'Run long-running Google workflow generations as background Interactions (submit + poll) to avoid timeouts. Off by default. Requires server-side conversation state; models that do not support it fall back automatically.',
    honoredBy: everyHost(
      'src/agent/modelHandlers/google/modelHandlerGoogleInteractions.ts',
    ),
    model: {
      provider: 'google',
      label: 'Background responses',
      description:
        'Run long-running workflow generations as background Interactions (submit + poll) to avoid timeouts. Off by default. Requires server-side conversation state; models that do not support it fall back automatically.',
    },
  }),
  'model.useBackgroundResponses': modelProviderToggle({
    default: true,
    title: 'Background responses',
    description:
      'Keep long-running OpenAI requests alive in the background (polling) instead of timing out after 10 minutes. Applies automatically to GPT models running workflow agents; ignored otherwise. Disable to fall back to synchronous streaming requests.',
    honoredBy: everyHost(
      'src/agent/modelHandlers/openai/modelHandlerOpenAIResponse.ts',
    ),
    model: {
      provider: 'openai',
      label: 'Background responses',
      description:
        'Handle long-running generations (>10 min) via polling to prevent timeouts. Adds polling overhead.',
    },
  }),
  'model.openaiParallelToolCalls': modelProviderToggle({
    default: true,
    title: 'Parallel tool calls',
    description:
      'Let OpenAI models use multiple tools at the same time for faster results. Enabled by default; disable for models that require sequential tool execution.',
    honoredBy: everyHost(
      'src/agent/modelHandlers/openai/modelHandlerOpenAI.ts',
    ),
    model: {
      provider: 'openai',
      label: 'Parallel tool calls',
      description:
        'Allow the model to call multiple tools in parallel. On by default; disable for models that require sequential execution.',
    },
  }),
  // No `configTarget`: both runtime readers resolve the *merged* config value
  // through `getValidatedConfig`, so the row must not narrow itself to the
  // global scope — a workspace override the runtime honors would then be
  // invisible in (and unwritable from) the settings view.
  'model.compactionThresholdPercent': {
    schema: ModelCompactionThresholdPercentSchema,
    title: 'Compaction threshold',
    description: MODEL_COMPACTION_THRESHOLD_SETTING.description,
    category: 'model',
    honoredBy: everyHost('src/agent/modelHandlers/ModelHandler.ts', {
      command:
        'texra agents run <tool-use-agent> --instruction "answer a short question"',
      through:
        'packages/cli/src/commands/agentsRun.ts -> packages/cli/src/runtime/runExecution.ts -> src/agent/runtime/ModelFactory.ts -> src/agent/modelHandlers/ModelHandler.ts',
    }),
    surfaces: { settingsView: 'multi-agent', cliConfig: true },
  },
  'model.retry.maxAttempts': {
    schema: ModelRetryMaxAttemptsSchema,
    title: 'Automatic retries',
    description: MODEL_RETRY_MAX_ATTEMPTS_SETTING.description,
    category: 'model',
    honoredBy: everyHost('src/agent/core/flows/ModelInvocationNode.ts', {
      command:
        'texra agents run <tool-use-agent> --instruction "answer a short question"',
      through:
        'packages/cli/src/commands/agentsRun.ts -> packages/cli/src/runtime/runExecution.ts -> src/agent/implementations/flows/tooluse/ToolUseRoundFlow.ts -> src/agent/core/flows/ModelInvocationNode.ts',
    }),
    surfaces: { settingsView: 'multi-agent', cliConfig: true },
  },
  // Thin provider modules own the public prefer-switch surface; the shared
  // factory in subscriptionPreference.ts is not a separate consumer key.
  'chatgptCodex.preferSubscription': {
    schema: z.boolean().prefault(false),
    description:
      'Prefer your signed-in ChatGPT subscription for Codex-eligible OpenAI models instead of API-key routing. Experimental. Subscription routing defaults to a 272,000-token input budget; use chatgptCodex.contextWindow to override it.',
    honoredBy: everyHost('src/model/codex/codexPreference.ts'),
  },
  'chatgptCodex.contextWindow': {
    schema: ChatgptCodexContextWindowSchema,
    title: 'Subscription input token budget',
    description: CHATGPT_CODEX_CONTEXT_WINDOW_SETTING.description,
    category: 'model',
    honoredBy: everyHost('src/model/providerCapabilities.ts', {
      command:
        'texra agents run <tool-use-agent> --instruction "answer a short question"',
      through:
        'packages/cli/src/commands/agentsRun.ts -> packages/cli/src/runtime/runExecution.ts -> src/agent/runtime/ModelFactory.ts -> src/agent/modelHandlers/openai/modelHandlerCodex.ts -> src/model/providerCapabilities.ts',
    }),
    surfaces: { cliConfig: true },
  },
  'xaiGrok.preferSubscription': {
    schema: z.boolean().prefault(false),
    description:
      'Prefer your signed-in Grok (xAI SuperGrok) account for xAI models instead of API-key routing. Experimental. Uses the public Grok CLI OAuth client; xAI may change or revoke that registration without notice.',
    honoredBy: everyHost('src/model/xai/xaiPreference.ts'),
  },
  maxImageDimension: {
    schema: z.number().min(100).max(10000).prefault(2000),
    description:
      'Maximum dimension (width or height) in pixels for images before resizing. Images larger than this will be resized to fit within this dimension while maintaining aspect ratio.',
    honoredBy: everyHost('src/utils/media/img.ts'),
  },
  'bib.defaultPath': {
    schema: z.string().prefault(''),
    description:
      'Default path to bibliography file (.bib). This is used by bibliography tools when no explicit path is provided. Supports Zotero auto-exported .bib files.',
    honoredBy: everyHost('src/tools/latex/ExtractBibliographyTool.ts'),
  },
  'bib.zoteroPort': {
    schema: z.number().min(1).max(65535).prefault(23119),
    description:
      'Port number for Zotero integration (default: 23119). Used by both the Connector API and Better BibTeX JSON-RPC.',
    honoredBy: everyHost('src/tools/zotero/bbtClient.ts'),
  },
  'latex.latexindentConfig': {
    schema: z.string().prefault(''),
    description: 'Path to latexindent configuration file',
    honoredBy: everyHost('src/latex/formatter/latexindentpt.ts'),
  },
  'latex.texfmtConfig': {
    schema: z.string().prefault(''),
    description: 'Path to tex-fmt configuration file',
    honoredBy: everyHost('src/latex/formatter/texfmt.ts'),
  },
  'latex.tikzInputDirectory': {
    schema: z.string().prefault(''),
    description:
      'Directory where to look for extra input files when compiling extracted TikZ figures. Absolute path is required. Sets TEXINPUTS environment variable for TikZ compilation.',
    honoredBy: everyHost('src/latex/texTools.ts'),
  },
  'latex.includeWorkspaceInTexinputs': {
    schema: z.boolean().prefault(true),
    description:
      'Include the workspace root directory in TEXINPUTS when compiling TikZ figures',
    honoredBy: everyHost('src/latex/texTools.ts'),
  },
  'latex.tikzTemplate': {
    schema: z.string().prefault(DEFAULT_TIKZ_TEMPLATE),
    description:
      'Template used for generating standalone documents when extracting and compiling TikZ figures',
    honoredBy: everyHost('src/latex/TikzPictureManager.ts'),
  },
  'latex.wrapCritiqueInAlign': {
    schema: z.boolean().prefault(true),
    title: 'Wrap criticism in align environments',
    description:
      'Wrap bare criticism and comment commands inside align environments with intertext.',
    category: 'latex',
    honoredBy: everyHost(REPLACEMENT_ENGINE_READER),
    surfaces: { settingsView: 'latex' },
  },
  'latex.enabledReplacements': {
    schema: z
      .array(z.enum(NON_REGEX_REPLACEMENT_CATEGORIES))
      .prefault(DEFAULT_ENABLED_REPLACEMENTS),
    title: 'Literal replacement groups',
    description: 'Enabled groups of direct LaTeX cleanup replacements.',
    category: 'latex',
    honoredBy: everyHost(REPLACEMENT_ENGINE_READER),
    surfaces: { settingsView: 'latex' },
  },
  'latex.enabledReplacementsRegex': {
    schema: z
      .array(z.enum(REGEX_REPLACEMENT_CATEGORIES))
      .prefault(DEFAULT_ENABLED_REGEX_REPLACEMENTS),
    title: 'Pattern replacement groups',
    description: 'Enabled groups of pattern-based LaTeX cleanup replacements.',
    category: 'latex',
    honoredBy: everyHost(REPLACEMENT_ENGINE_READER),
    surfaces: { settingsView: 'latex' },
  },
  'latex.customReplacementsRegex': {
    schema: z.record(z.string(), z.string()).prefault({}),
    title: 'Custom pattern replacements',
    description: 'Custom regular-expression replacements.',
    category: 'latex',
    honoredBy: everyHost(REPLACEMENT_ENGINE_READER),
    surfaces: { settingsView: 'latex' },
  },
  'latex.customReplacements': {
    schema: z.record(z.string(), z.string()).prefault({}),
    title: 'Custom literal replacements',
    description: 'Custom direct text replacements.',
    category: 'latex',
    honoredBy: everyHost(REPLACEMENT_ENGINE_READER),
    surfaces: { settingsView: 'latex' },
  },
  'latexdiff.tempFileLocation': {
    schema: z.enum(LATEXDIFF_TEMP_FILE_LOCATIONS).prefault('sameDirectory'),
    description:
      'Where to create temporary files for LaTeX preview and diff operations during tool edit approval.',
    enumDescriptions: [
      'Create temp files in the same directory as the original file. Best for resolving \\input{} and relative paths.',
      'Create temp files in .texra-temp directory at workspace root. Keeps source directories clean but may break relative paths.',
    ],
    honoredBy: everyHost('src/tools/approval/latexPreview.ts'),
  },
  // Only the extension's git commands read the commit count. The setup
  // assistant's host-neutral `update_config` writer is recorded separately so
  // a CLI-written value is recognized without mislabeling the writer as a reader.
  'git.numberOfCommitsToShow': {
    schema: z.number().min(1).max(1000).prefault(20),
    description:
      'Number of recent commits to show in the commit selection dropdown',
    honoredBy: {
      vscode: {
        reader: 'packages/extension/src/commands/git/gitCommands.ts',
      },
    },
    writtenBy: {
      cli: { writer: 'src/tools/setup/ConfigTools.ts' },
    },
  },
  'agentReview.runOnCommit': {
    schema: z.boolean().prefault(false),
    description:
      'Automatically review your changes for issues after each commit.',
    honoredBy: {
      vscode: {
        reader:
          'packages/extension/src/frontend/review/agentReviewCommitWatcher.ts',
      },
    },
  },
  'audio.soxPath': {
    schema: z.string().prefault(''),
    description: 'Path to the SoX executable. Overrides automatic detection.',
    honoredBy: everyHost('src/tools/media/audio.ts'),
  },
  'logger.debugMode': {
    schema: z.boolean().prefault(false),
    description: 'Whether to show verbose debug messages in the logger view',
    honoredBy: everyHost('src/logger/logUtils.ts'),
  },
  'telemetry.enabled': {
    schema: z.boolean().prefault(TELEMETRY_ENABLED_DEFAULT),
    title: 'Share usage telemetry',
    description:
      'Send model, token, cost, timing, route, and host metadata. TeXRA never sends prompt text, document content, or file names. Turning this off stops reporting for rounds billed to your own API keys; rounds covered by a subscription are still recorded, because they meter your usage against your plan.',
    category: 'account',
    configTarget: 'global',
    honoredBy: everyHost('src/telemetry/UsageLogService.ts'),
    surfaces: { settingsView: 'telemetry' },
  },
  'debug.saveModelIO': {
    schema: z.boolean().prefault(false),
    description:
      'Save what TeXRA sends to and receives from the model: the request messages and raw responses as JSON, plus the final input prompt as XML.',
    honoredBy: everyHost('src/agent/debug/debugMessageSaver.ts'),
  },
  'skills.enabled': {
    schema: AgentSkillsEnabledSchema.prefault(AGENT_SKILLS_ENABLED_DEFAULT),
    title: 'Make skills available to tool-use agents',
    description:
      'Discover TeXRA and imported skills and expose them to tool-use agent prompts.',
    category: 'tools',
    honoredBy: everyHost('src/agent/prompt/userVars.ts', {
      command:
        'texra agents run <tool-use-agent> --instruction "answer a short question"',
      through:
        'packages/cli/src/commands/agentsRun.ts -> packages/cli/src/runtime/runExecution.ts -> src/agent/runtime/runAgent.ts -> src/agent/runtime/executeAgent.ts -> src/agent/runtime/AgentLaunchContext.ts -> src/agent/prompt/userVars.ts',
    }),
    surfaces: { settingsView: 'agent-skills', cliConfig: true },
  },
  'toolUse.requireEditApproval': {
    schema: z.boolean().prefault(true),
    title: 'Under Ask: require approval for file edits',
    description:
      'When approval policy is Ask, show a diff before an agent changes workspace files. Inert under Never and Auto-approve.',
    category: 'tools',
    honoredBy: everyHost('src/tools/approval/toolEditApproval.ts'),
    surfaces: { settingsView: 'approval' },
  },
  'toolUse.requireBashApproval': {
    schema: z.boolean().prefault(true),
    title: 'Under Ask: require approval for shell commands',
    description:
      'When approval policy is Ask, pause before an agent runs a shell command. Inert under Never and Auto-approve.',
    category: 'tools',
    honoredBy: everyHost('src/tools/approval/bashApproval.ts'),
    surfaces: { settingsView: 'approval' },
  },
};

/** The config-file-backed rows, with their derived key and uniform slot. */
const CORE_TREE_SETTINGS: readonly StateSettingEntry[] = Object.entries(
  CORE_SETTING_ROWS,
).map(([path, row]) => ({
  ...row,
  key: `texra.${path}`,
  slots: sameSlot('config'),
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
    schema: TexraApprovalPolicySchema.prefault(TEXRA_APPROVAL_POLICY_DEFAULT),
    // Hand-edited config files carry spacing/casing variants; the row owns that
    // normalization so every reader through `readSetting` accepts what
    // `parseTexraApprovalPolicy` has always accepted.
    normalizePersisted: (raw) =>
      typeof raw === 'string' ? raw.trim().toLowerCase() : raw,
    title: 'Approval policy',
    description:
      'Deny, ask, or auto-approve Bash and tool edits for this workspace. Under Ask, the two toggles below control each kind independently.',
    category: 'tools',
    slots: sameSlot('config'),
    honoredBy: {
      vscode: { reader: 'src/utils/config/platformSettings.ts' },
      desktop: { reader: 'src/utils/config/platformSettings.ts' },
      cli: {
        reader: 'packages/cli/src/runtime/cliConfig.ts',
        reachability: {
          command:
            'texra agents run <tool-use-agent> --instruction "run a shell command"',
          through:
            'packages/cli/src/commands/agentsRun.ts -> packages/cli/src/runtime/runExecution.ts -> packages/cli/src/runtime/cliContext.ts -> packages/cli/src/runtime/cliConfig.ts -> src/agent/runtime/SessionHandle.ts -> src/tools/approval/bashApproval.ts',
        },
      },
    },
    enumLabels: ['Never', 'Ask', 'Auto-approve'],
    surfaces: { settingsView: 'approval', cliConfig: true },
  }),
];

// ============================================================================
// State-backed rows
// ============================================================================

const GIT_AUTHOR_READER = 'packages/cli/src/runtime/gitAuthor.ts';
const CODEX_CONFIG_READER = 'src/tools/codexConfig.ts';
const CLAUDE_AGENT_CONFIG_READER = 'src/tools/claudeAgentConfig.ts';
const WORKFLOW_COMPILE_READER =
  'src/agent/implementations/flows/reflection/output/compileCheck.ts';
const PROXY_CONFIG_READER =
  'src/agent/modelHandlers/support/ProxyConfigResolver.ts';
const PROVIDER_CONFIG_READER = 'src/utils/config/providerConfig.ts';

const GIT_AUTHOR_RUNTIME_REACHABILITY = {
  command:
    'texra agents run <tool-use-agent> --instruction "create a git commit"',
  through:
    'packages/cli/src/runtime/initPlatform.ts -> packages/cli/src/runtime/gitAuthor.ts -> src/utils/system/execUtils.ts',
} satisfies CliRuntimeReachability;
const GIT_WORKTREE_RUNTIME_REACHABILITY = {
  command:
    'texra agents run <tool-use-agent> --instruction "delegate a task to a subagent"',
  through:
    'packages/cli/src/runtime/initPlatform.ts -> packages/cli/src/runtime/gitAuthor.ts -> src/tools/delegation/DelegationTools.ts',
} satisfies CliRuntimeReachability;
const DETACH_SUBAGENTS_RUNTIME_REACHABILITY = {
  command: 'texra chat',
  through:
    'packages/cli/src/commands/chat.ts -> packages/cli/src/chat/tui/runChatTui.tsx -> packages/cli/src/chat/chatSessionController.ts -> src/agent/runtime/detachSubagentsOnStop.ts',
} satisfies CliRuntimeReachability;
const ORCHESTRATOR_KILL_RUNTIME_REACHABILITY = {
  command:
    'texra agents run <tool-use-agent> --instruction "delegate two tasks, then stop the slower subagent"',
  through:
    'packages/cli/src/commands/agentsRun.ts -> src/agent/runtime/runAgent.ts -> src/tools/ExecutionsTool.ts',
} satisfies CliRuntimeReachability;
const WORKFLOW_COMPILE_RUNTIME_REACHABILITY = {
  command:
    'texra run <workflow-agent> --input paper.tex --instruction "revise the paper"',
  through:
    'packages/cli/src/commands/workflow.ts -> src/agent/implementations/flows/reflection/output/compileCheck.ts',
} satisfies CliRuntimeReachability;
const WORKFLOW_REJECT_RUNTIME_REACHABILITY = {
  command:
    'texra run <workflow-agent> --input paper.tex --instruction "revise the paper"',
  through:
    'packages/cli/src/commands/workflow.ts -> src/agent/implementations/flows/reflection/runReflectionFlow.ts',
} satisfies CliRuntimeReachability;
const OPENAI_WEBSOCKET_RUNTIME_REACHABILITY = {
  command:
    'texra run <workflow-agent> --model <openai-model> --input paper.tex --instruction "summarize the paper"',
  through:
    'packages/cli/src/commands/workflow.ts -> src/agent/modelHandlers/openai/modelHandlerOpenAIResponse.ts',
} satisfies CliRuntimeReachability;
const OPENROUTER_ROUTING_RUNTIME_REACHABILITY = {
  command:
    'texra agents run <tool-use-agent> --model <openrouter-routable-model> --instruction "answer a short question"',
  through:
    'packages/cli/src/commands/agentsRun.ts -> packages/cli/src/runtime/runExecution.ts -> src/agent/runtime/ModelFactory.ts -> src/utils/config/providerConfig.ts',
} satisfies CliRuntimeReachability;
const KIMI_CODE_ROUTING_RUNTIME_REACHABILITY = {
  // Requires a Kimi Code API key (`texra chat` /key flow or KIMI_CODE_API_KEY).
  command:
    'texra agents run <tool-use-agent> --model kimi3 --instruction "answer a short question"',
  through:
    'packages/cli/src/commands/agentsRun.ts -> packages/cli/src/runtime/runExecution.ts -> src/agent/runtime/ModelFactory.ts -> src/model/kimiCodeSubscriptionRouting.ts',
} satisfies CliRuntimeReachability;
const PROVIDER_REGION_RUNTIME_REACHABILITY = {
  command:
    'texra agents run <tool-use-agent> --model <dashscope/minimax/moonshot/glm-model> --instruction "answer a short question"',
  through:
    'packages/cli/src/commands/agentsRun.ts -> packages/cli/src/runtime/runExecution.ts -> src/agent/runtime/ModelFactory.ts -> src/agent/modelHandlers/ModelHandler.ts -> src/agent/modelHandlers/support/ProxyConfigResolver.ts',
} satisfies CliRuntimeReachability;
const PROVIDER_ENDPOINT_RUNTIME_REACHABILITY = {
  command:
    'texra agents run <tool-use-agent> --model <provider-model> --instruction "answer a short question"',
  through:
    'packages/cli/src/commands/agentsRun.ts -> packages/cli/src/runtime/runExecution.ts -> src/agent/runtime/ModelFactory.ts -> src/agent/modelHandlers/support/ProxyConfigResolver.ts',
} satisfies CliRuntimeReachability;
const CODEX_AGENT_RUNTIME_REACHABILITY = {
  command:
    'texra agents run <tool-use-agent> --instruction "launch a Codex subagent"',
  through:
    'packages/cli/src/commands/agentsRun.ts -> packages/cli/src/runtime/runExecution.ts -> src/tools/codex.ts -> src/tools/codexConfig.ts',
} satisfies CliRuntimeReachability;
const CLAUDE_AGENT_RUNTIME_REACHABILITY = {
  command:
    'texra agents run <tool-use-agent> --instruction "launch a Claude Code subagent"',
  through:
    'packages/cli/src/commands/agentsRun.ts -> packages/cli/src/runtime/runExecution.ts -> src/tools/claudeAgent.ts -> src/tools/claudeAgentConfig.ts',
} satisfies CliRuntimeReachability;
const TOOL_AVAILABILITY_RUNTIME_REACHABILITY = {
  command:
    'texra agents run <tool-use-agent> --instruction "use an external tool"',
  through:
    'packages/cli/src/commands/agentsRun.ts -> packages/cli/src/runtime/runExecution.ts -> src/agent/runtime/agentToolResolution.ts -> src/tools/toolAvailability.ts',
} satisfies CliRuntimeReachability;
const TOOL_PATH_PROTECTION_RUNTIME_REACHABILITY = {
  command:
    'texra agents run <tool-use-agent> --instruction "read a file outside the working directory"',
  through:
    'packages/cli/src/commands/agentsRun.ts -> packages/cli/src/runtime/runExecution.ts -> src/tools/pathResolution.ts',
} satisfies CliRuntimeReachability;

/**
 * Git identity rows keep the one documented slot divergence in the catalog:
 * the extension and desktop store them in worktree-shared WorkspaceState while
 * the CLI reads them from `.texra/config.json`, which is where an existing
 * user's values already live.
 */
const GIT_AUTHOR_SLOTS: SettingSlots = {
  vscode: 'workspaceState',
  desktop: 'workspaceState',
  cli: 'config',
};

const GIT_AUTHOR_HONORED_BY: SettingHonoredBy = {
  vscode: { reader: 'packages/extension/src/frontend/git/gitAuthorSetup.ts' },
  desktop: { reader: 'packages/desktop/src/main/desktopSettingsIpc.ts' },
  cli: {
    reader: GIT_AUTHOR_READER,
    reachability: GIT_AUTHOR_RUNTIME_REACHABILITY,
  },
};

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
      slots: sameSlot('globalState'),
      honoredBy: everyHost(
        PROXY_CONFIG_READER,
        PROVIDER_ENDPOINT_RUNTIME_REACHABILITY,
      ),
      surfaces: { settingsView: 'profile', cliConfig: true },
    }),
);

/**
 * Per-provider streaming toggles. Reads stay in `providerConfig`'s
 * `getProviderStreaming`, whose default-when-unset is the *global* streaming
 * toggle — the static `.prefault(true)` here matches that global default.
 */
const PROVIDER_STREAMING_SETTINGS = PROVIDER_STATE_ENTRIES.flatMap(
  ({ streamingKey, displayName }) =>
    streamingKey
      ? [
          surfacedSetting({
            key: streamingKey,
            schema: z.boolean().prefault(true),
            title: `${displayName} streaming`,
            description: `Stream ${displayName} responses incrementally instead of waiting for the full completion.`,
            category: 'model',
            slots: sameSlot('globalState'),
            honoredBy: everyHost(PROVIDER_CONFIG_READER),
            surfaces: { settingsView: 'profile' },
          }),
        ]
      : [],
);

/**
 * Region/routing toggles resolved by `ProxyConfigResolver`, each also a Models
 * tab control for its provider. The rows differ only in key, default, and
 * copy, so the shared fields are written once.
 */
const PROVIDER_ROUTING_SETTINGS = (
  [
    [
      GlobalStateKey.MOONSHOT_USE_CHINA,
      'moonshot',
      true,
      {
        label: 'Kimi/Moonshot China region',
        description:
          'Use the China endpoint (api.moonshot.cn) instead of international (api.moonshot.ai). Enabled by default. Keys are platform-specific — get international keys at platform.moonshot.ai.',
        warning:
          'A platform.moonshot.cn key does not work with the international endpoint, and vice versa.',
        warningUrl: 'https://platform.moonshot.ai/console',
        warningUrlLabel: 'International console',
      },
    ],
    [
      GlobalStateKey.DASHSCOPE_USE_CHINA,
      'dashscope',
      false,
      {
        label: 'Qwen China region (Bailian)',
        description:
          'Use the China region endpoint (dashscope.aliyuncs.com) instead of international (dashscope-intl.aliyuncs.com). Display name switches to "Bailian".',
      },
    ],
    [
      GlobalStateKey.MINIMAX_USE_CHINA,
      'minimax',
      false,
      {
        label: 'MiniMax China region',
        description:
          'Use the China region endpoint (api.minimaxi.com) instead of international (api.minimax.io). API keys are region-specific — you must obtain a key from the matching region.',
        warning:
          'International keys do not work with the China endpoint, and vice versa. Coding Plan keys are also region-specific.',
        warningUrl: 'https://platform.minimax.io/',
        warningUrlLabel: 'Get API key',
      },
    ],
    [
      GlobalStateKey.GLM_USE_CHINA,
      'glm',
      true,
      {
        label: 'GLM China region',
        description:
          'Use the China region endpoint (open.bigmodel.cn) instead of international (api.z.ai). Enabled by default. API keys work with either endpoint.',
        warningUrl: 'https://open.bigmodel.cn/',
        warningUrlLabel: 'BigModel console',
      },
    ],
  ] as const
).map(([key, provider, defaultValue, copy]) =>
  surfacedSetting({
    key,
    schema: z.boolean().prefault(defaultValue),
    title: copy.label,
    description: copy.description,
    category: 'model',
    slots: sameSlot('globalState'),
    honoredBy: everyHost(
      PROXY_CONFIG_READER,
      PROVIDER_REGION_RUNTIME_REACHABILITY,
    ),
    surfaces: {
      settingsView: 'profile',
      cliConfig: true,
      models: [{ provider, ...copy }],
    },
  }),
);

export const STATE_SETTINGS: readonly StateSettingEntry[] = [
  // --- Git commit author marking ---------------------------------------------
  surfacedSetting({
    key: WorkspaceStateKey.GIT_MARK_COMMITS,
    schema: z.boolean().prefault(DEFAULT_GIT_MARK_COMMITS),
    title: 'Mark agent commits',
    description:
      'Attribute agent-authored git commits to the TeXRA identity so they are distinguishable from your own commits.',
    category: 'git',
    slots: GIT_AUTHOR_SLOTS,
    honoredBy: GIT_AUTHOR_HONORED_BY,
    surfaces: { settingsView: 'git-author', cliConfig: true },
  }),
  surfacedSetting({
    key: WorkspaceStateKey.GIT_AUTHOR_NAME,
    // `.min(1)` so a blank value is rejected at the write boundary and a
    // legacy blank read falls back (loudly) to the default identity, which is
    // what `readGitAuthorSettingsFromState`'s `||` has always done for git.
    schema: z.string().min(1).prefault(DEFAULT_GIT_AUTHOR_NAME),
    title: 'Agent commit author',
    description:
      'Author and committer name used for agent-authored commits when commit marking is enabled.',
    category: 'git',
    slots: GIT_AUTHOR_SLOTS,
    honoredBy: GIT_AUTHOR_HONORED_BY,
    surfaces: { settingsView: 'git-author', cliConfig: true },
  }),
  surfacedSetting({
    key: WorkspaceStateKey.GIT_AUTHOR_EMAIL,
    schema: z.string().min(1).prefault(DEFAULT_GIT_AUTHOR_EMAIL),
    title: 'Agent commit email',
    description:
      'Author and committer email used for agent-authored commits when commit marking is enabled.',
    category: 'git',
    slots: GIT_AUTHOR_SLOTS,
    honoredBy: GIT_AUTHOR_HONORED_BY,
    surfaces: { settingsView: 'git-author', cliConfig: true },
  }),
  surfacedSetting({
    key: WorkspaceStateKey.GIT_WORKTREE_SUPPORT,
    schema: z.boolean().prefault(DEFAULT_GIT_WORKTREE_SUPPORT),
    title: 'Subagent worktrees',
    description:
      'Allow spawned subagents to run in isolated git worktrees so parallel edits do not conflict.',
    category: 'git',
    slots: GIT_AUTHOR_SLOTS,
    honoredBy: {
      ...GIT_AUTHOR_HONORED_BY,
      cli: {
        reader: GIT_AUTHOR_READER,
        reachability: GIT_WORKTREE_RUNTIME_REACHABILITY,
      },
    },
    surfaces: { settingsView: 'git-author', cliConfig: true },
  }),

  // --- Multi-agent coordination --------------------------------------------
  // Both child-work policy toggles live in `globalState` per the 2026-08-15
  // maintainer ruling (docs/proposals/2026-08-15-shared-contracts-and-retirement.md
  // §2.1): they describe how *this user* wants child runs handled, not anything
  // about a particular checkout, so no worktree-scoping need is documented on
  // either row. Before the move the extension smuggled that same intent past a
  // `workspaceState` slot via `WORKTREE_SHARED_KEYS`, while the Node hosts
  // scoped the value per workspace-path hash — one row, two meanings.
  surfacedSetting({
    key: GlobalStateKey.ALLOW_ORCHESTRATOR_KILL,
    schema: z.boolean().prefault(true),
    title: 'Allow orchestrator cancellation',
    description:
      'Allow the orchestrator to stop subagents that are no longer needed.',
    category: 'multi-agent',
    slots: sameSlot('globalState'),
    honoredBy: everyHost(
      'src/tools/ExecutionsTool.ts',
      ORCHESTRATOR_KILL_RUNTIME_REACHABILITY,
    ),
    surfaces: { settingsView: 'multi-agent', cliConfig: true },
  }),
  surfacedSetting({
    key: GlobalStateKey.DETACH_SUBAGENTS_ON_STOP,
    schema: z.boolean().prefault(false),
    title: 'Keep subagents running',
    description:
      'Let active subagents continue when the orchestrator is stopped.',
    category: 'multi-agent',
    slots: sameSlot('globalState'),
    honoredBy: everyHost(
      'src/agent/runtime/detachSubagentsOnStop.ts',
      DETACH_SUBAGENTS_RUNTIME_REACHABILITY,
    ),
    surfaces: { settingsView: 'multi-agent', cliConfig: true },
  }),

  // --- Memory ---------------------------------------------------------------
  // Every host's runtime honors the key through `registerAgentFeatures()`, but
  // only the settings view renders it; the CLI has no `/config` row for it.
  surfacedSetting({
    key: GlobalStateKey.MEMORY_ENABLED,
    schema: z.boolean().prefault(true),
    title: 'Enable memory for chat agents',
    description: 'Remember useful details across chat sessions.',
    category: 'tools',
    slots: sameSlot('globalState'),
    honoredBy: everyHost('src/agent/features.ts'),
    surfaces: { settingsView: 'memory' },
  }),

  // --- External coding agent controls ---------------------------------------
  surfacedSetting({
    key: WorkspaceStateKey.CODEX_SANDBOX_MODE,
    schema: CodexSandboxModeSchema.prefault(CODEX_SANDBOX_MODE_DEFAULT),
    title: 'Codex sandbox mode',
    description: 'Filesystem access mode used when TeXRA launches Codex.',
    category: 'ai-agents',
    slots: sameSlot('workspaceState'),
    honoredBy: everyHost(CODEX_CONFIG_READER, CODEX_AGENT_RUNTIME_REACHABILITY),
    enumLabels: ['Read-only', 'Workspace write', 'Full access'],
    surfaces: { settingsView: 'approval', cliConfig: true },
  }),
  surfacedSetting({
    key: WorkspaceStateKey.CODEX_REASONING_EFFORT,
    schema: CodexReasoningEffortSchema.prefault(CODEX_REASONING_EFFORT_DEFAULT),
    title: 'Codex reasoning effort',
    description: 'Reasoning effort hint passed to Codex runs.',
    category: 'ai-agents',
    slots: sameSlot('workspaceState'),
    honoredBy: everyHost(CODEX_CONFIG_READER, CODEX_AGENT_RUNTIME_REACHABILITY),
    enumLabels: ['Low', 'Medium', 'High', 'Extra high'],
    surfaces: { settingsView: 'approval', cliConfig: true },
  }),
  surfacedSetting({
    key: WorkspaceStateKey.CODEX_APPROVAL_POLICY,
    schema: CodexApprovalPolicySchema.prefault(CODEX_APPROVAL_POLICY_DEFAULT),
    title: 'Codex approval policy',
    description: 'When Codex should ask for approval before risky actions.',
    category: 'ai-agents',
    slots: sameSlot('workspaceState'),
    honoredBy: everyHost(CODEX_CONFIG_READER, CODEX_AGENT_RUNTIME_REACHABILITY),
    enumLabels: [
      'Auto approve',
      'Ask when requested',
      'Ask for untrusted',
      'Ask on failure',
    ],
    surfaces: { settingsView: 'approval', cliConfig: true },
  }),
  surfacedSetting({
    key: WorkspaceStateKey.CLAUDE_AGENT_MODEL,
    schema: ClaudeAgentModelSchema.prefault(CLAUDE_AGENT_DEFAULT_MODEL),
    normalizePersisted: parseClaudeAgentModel,
    title: 'Claude Code model',
    description: 'Claude model selected for Claude Code agent sessions.',
    category: 'ai-agents',
    slots: sameSlot('workspaceState'),
    honoredBy: everyHost(
      CLAUDE_AGENT_CONFIG_READER,
      CLAUDE_AGENT_RUNTIME_REACHABILITY,
    ),
    enumLabels: ['Sonnet 5', 'Fable 5', 'Opus 5', 'Haiku 4.5'],
    surfaces: { settingsView: 'approval', cliConfig: true },
  }),
  surfacedSetting({
    key: WorkspaceStateKey.CLAUDE_AGENT_PERMISSION_MODE,
    schema: ClaudeAgentPermissionModeSchema.prefault(
      CLAUDE_AGENT_DEFAULT_PERMISSION_MODE,
    ),
    title: 'Claude Code permission mode',
    description: 'Permission policy used by Claude Code agent sessions.',
    category: 'ai-agents',
    slots: sameSlot('workspaceState'),
    honoredBy: everyHost(
      CLAUDE_AGENT_CONFIG_READER,
      CLAUDE_AGENT_RUNTIME_REACHABILITY,
    ),
    enumLabels: [
      'Prompt for risky actions',
      'Auto-accept edits',
      'Bypass all (dangerous)',
      'Plan only (read-only)',
    ],
    surfaces: { settingsView: 'approval', cliConfig: true },
  }),
  surfacedSetting({
    key: WorkspaceStateKey.CLAUDE_AGENT_EFFORT,
    schema: ClaudeAgentEffortSchema.prefault(CLAUDE_AGENT_DEFAULT_EFFORT),
    title: 'Claude Code reasoning effort',
    description: 'Reasoning effort hint passed to Claude Code agent sessions.',
    category: 'ai-agents',
    slots: sameSlot('workspaceState'),
    honoredBy: everyHost(
      CLAUDE_AGENT_CONFIG_READER,
      CLAUDE_AGENT_RUNTIME_REACHABILITY,
    ),
    enumLabels: ['Low', 'Medium', 'High', 'Extra high', 'Maximum'],
    surfaces: { settingsView: 'approval', cliConfig: true },
  }),

  // --- Workflow auto-compile -------------------------------------------------
  surfacedSetting({
    key: WorkspaceStateKey.WORKFLOW_AUTO_COMPILE,
    schema: z.boolean().prefault(LATEX_CONFIG_DEFAULTS.workflowAutoCompile),
    title: 'Auto-compile outputs',
    description:
      'Compile the LaTeX project automatically after an agent writes its output.',
    category: 'workflow',
    slots: sameSlot('workspaceState'),
    honoredBy: everyHost(
      WORKFLOW_COMPILE_READER,
      WORKFLOW_COMPILE_RUNTIME_REACHABILITY,
    ),
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
    slots: sameSlot('workspaceState'),
    honoredBy: everyHost(
      WORKFLOW_COMPILE_READER,
      WORKFLOW_COMPILE_RUNTIME_REACHABILITY,
    ),
    surfaces: { settingsView: 'latex', cliConfig: true },
  }),
  surfacedSetting({
    key: WorkspaceStateKey.WORKFLOW_AUTO_OPEN_PDF,
    schema: z.boolean().prefault(LATEX_CONFIG_DEFAULTS.workflowAutoOpenPdf),
    description:
      'Open the compiled PDF automatically after a successful auto-compile.',
    category: 'workflow',
    slots: sameSlot('workspaceState'),
    // Read by the reflection flow, but the emitted `requestOpenFile` has no CLI
    // handler (headless), so the CLI does not honor it.
    honoredBy: webviewHosts(
      'src/agent/implementations/flows/reflection/nodes/OutputNode.ts',
    ),
    surfaces: { settingsView: 'latex' },
  }),
  surfacedSetting({
    key: WorkspaceStateKey.WORKFLOW_REJECT_ON_COMPILE_FAILURE,
    schema: z
      .boolean()
      .prefault(LATEX_CONFIG_DEFAULTS.workflowRejectOnCompileFailure),
    title: 'Reject compile failures',
    description:
      'Reject an agent edit when the automatic post-output compile fails, so broken LaTeX is not accepted.',
    category: 'workflow',
    slots: sameSlot('workspaceState'),
    // Also read by OutputNode.ts (compileFailureContext gate); the row names
    // the extra-round grant in runReflectionFlow.ts as its reader evidence.
    honoredBy: everyHost(
      'src/agent/implementations/flows/reflection/runReflectionFlow.ts',
      WORKFLOW_REJECT_RUNTIME_REACHABILITY,
    ),
    surfaces: { settingsView: 'latex', cliConfig: true },
  }),

  // --- LaTeXdiff -------------------------------------------------------------
  // Run by the reflection flow, so every host honors them; deferred from the
  // CLI `/config` panel by product decision, which is a surface choice only.
  surfacedSetting({
    key: WorkspaceStateKey.LATEXDIFF_BETWEEN_ROUNDS,
    schema: z.boolean().prefault(LATEX_CONFIG_DEFAULTS.latexdiffBetweenRounds),
    description:
      'Generate a latexdiff between successive reflection rounds, not just against the original input.',
    category: 'latexdiff',
    slots: sameSlot('workspaceState'),
    honoredBy: everyHost(
      'src/agent/implementations/flows/reflection/output/LatexDiffManager.ts',
    ),
    surfaces: { settingsView: 'latex' },
  }),
  surfacedSetting({
    key: WorkspaceStateKey.LATEXDIFF_TIMEOUT_MS,
    schema: z
      .int()
      .min(LATEX_CONFIG_RANGES.latexdiffTimeoutMs.min)
      .max(LATEX_CONFIG_RANGES.latexdiffTimeoutMs.max)
      .prefault(LATEX_CONFIG_DEFAULTS.latexdiffTimeoutMs),
    description:
      'Maximum time (in milliseconds) to allow a single latexdiff invocation to run.',
    category: 'latexdiff',
    slots: sameSlot('workspaceState'),
    honoredBy: everyHost('src/latex/latexdiff.ts'),
    surfaces: { settingsView: 'latex' },
  }),
  surfacedSetting({
    key: WorkspaceStateKey.LATEXDIFF_MATH_MARKUP,
    schema: z
      .enum(LATEXDIFF_MATH_MARKUP_VALUES)
      .prefault(LATEX_CONFIG_DEFAULTS.latexdiffMathMarkup),
    description: 'How latexdiff marks up changes inside math environments.',
    category: 'latexdiff',
    slots: sameSlot('workspaceState'),
    honoredBy: everyHost('src/latex/latexdiff/diffCommandExecutor.ts'),
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
    description:
      'Produce a changes-only diff (show only the parts that changed) rather than the full marked-up document.',
    category: 'latexdiff',
    slots: sameSlot('workspaceState'),
    honoredBy: everyHost('src/latex/latexdiff/diffCommandExecutor.ts'),
    surfaces: { settingsView: 'latex' },
  }),

  // --- LaTeX formatter -------------------------------------------------------
  surfacedSetting({
    key: WorkspaceStateKey.LATEX_FORMATTER,
    schema: z
      .enum(LATEX_FORMATTER_VALUES)
      .prefault(LATEX_CONFIG_DEFAULTS.latexFormatter),
    description: 'Which formatter to run when formatting LaTeX source.',
    category: 'latex',
    slots: sameSlot('workspaceState'),
    honoredBy: everyHost('src/latex/formatter/texFormatter.ts'),
    enumDescriptions: [
      'Format with latexindent.',
      'Format with tex-fmt.',
      'Do not run any formatter.',
    ],
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
    slots: sameSlot('globalState'),
    honoredBy: everyHost(
      'src/agent/modelHandlers/openai/modelHandlerOpenAIResponse.ts',
      OPENAI_WEBSOCKET_RUNTIME_REACHABILITY,
    ),
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

  // --- Provider endpoints & streaming ---------------------------------------
  ...PROVIDER_ENDPOINT_SETTINGS,
  ...PROVIDER_STREAMING_SETTINGS,
  surfacedSetting({
    key: GlobalStateKey.STREAMING_GLOBAL,
    schema: z.boolean().prefault(true),
    title: 'Enable streaming',
    description: 'Global default for all providers.',
    category: 'model',
    slots: sameSlot('globalState'),
    honoredBy: everyHost(PROVIDER_CONFIG_READER),
    surfaces: { settingsView: 'profile' },
  }),

  // --- Model picker preferences ---------------------------------------------
  surfacedSetting({
    key: GlobalStateKey.HELPER_MODEL,
    schema: z.string().min(1).prefault(DEFAULT_HELPER_MODEL),
    title: 'Helper model',
    description:
      'Model used for auxiliary tasks: instruction polishing, merges, and session descriptions.',
    category: 'model',
    slots: sameSlot('globalState'),
    honoredBy: everyHost('src/agent/runtime/helperModelName.ts'),
    surfaces: { settingsView: 'models' },
  }),
  surfacedSetting({
    key: GlobalStateKey.PREFER_SHORT_MODEL_NAMES,
    schema: z.boolean().prefault(false),
    title: 'Prefer short model names',
    description: 'Show compact model names in pickers.',
    category: 'model',
    slots: sameSlot('globalState'),
    honoredBy: everyHost('src/agent/runtime/ModelFactory.ts'),
    surfaces: { settingsView: 'models' },
  }),

  // --- OpenRouter routing ----------------------------------------------------
  surfacedSetting({
    key: GlobalStateKey.USE_OPENROUTER,
    schema: z.boolean().prefault(false),
    title: 'Use OpenRouter for all models',
    description:
      'Route all API calls through OpenRouter instead of direct provider APIs. Requires an OpenRouter API key; your OpenRouter key is always used directly.',
    category: 'model',
    slots: sameSlot('globalState'),
    honoredBy: everyHost(
      PROVIDER_CONFIG_READER,
      OPENROUTER_ROUTING_RUNTIME_REACHABILITY,
    ),
    onWrite: { invalidatesModelOptions: true },
    surfaces: {
      settingsView: 'profile',
      cliConfig: true,
      models: [
        {
          provider: 'openRouter',
          label: 'Use OpenRouter for all models',
          description:
            'Route all API calls through OpenRouter instead of direct provider APIs. Requires an OpenRouter API key; your OpenRouter key is always used directly.',
        },
      ],
    },
  }),

  // --- Provider routing & region toggles --------------------------------------
  surfacedSetting({
    key: GlobalStateKey.KIMI_CODE_PREFER,
    schema: z.boolean().prefault(false),
    title: 'Prefer Kimi Code',
    description:
      'Route dual-backend Kimi models (K3) through the Kimi Code coding endpoint when a Kimi Code API key is set. The two coding-only models always use the key. When off, K3 uses the Moonshot open platform.',
    category: 'model',
    slots: sameSlot('globalState'),
    honoredBy: everyHost(
      'src/agent/runtime/ModelFactory.ts',
      KIMI_CODE_ROUTING_RUNTIME_REACHABILITY,
    ),
    // Kimi Code and OpenRouter are alternative routes for the same dual-backend
    // models, so enabling one clears the other on every write path.
    onWrite: {
      disablesWhenEnabled: [GlobalStateKey.USE_OPENROUTER],
      invalidatesModelOptions: true,
    },
    surfaces: {
      settingsView: 'profile',
      cliConfig: true,
      models: [
        {
          provider: 'kimiCode',
          label: 'Prefer Kimi Code',
          description:
            'Route dual-backend Kimi models (K3) through the Kimi Code coding endpoint when a Kimi Code API key is set. The two coding-only models always use the key. When off, K3 uses the Moonshot open platform.',
        },
      ],
    },
  }),
  ...PROVIDER_ROUTING_SETTINGS,
  surfacedSetting({
    key: GlobalStateKey.GLM_CODING_PLAN,
    schema: z.boolean().prefault(false),
    title: 'GLM Coding Plan',
    description:
      'Use a Coding Plan subscription key instead of pay-as-you-go. Routes requests through the coding-specific endpoint with monthly quota limits.',
    category: 'model',
    slots: sameSlot('globalState'),
    honoredBy: everyHost(
      PROXY_CONFIG_READER,
      PROVIDER_REGION_RUNTIME_REACHABILITY,
    ),
    onWrite: { invalidatesModelOptions: true },
    surfaces: {
      settingsView: 'profile',
      cliConfig: true,
      models: [
        {
          provider: 'glm',
          label: 'GLM Coding Plan',
          description:
            'Use a Coding Plan subscription key instead of pay-as-you-go. Routes requests through the coding-specific endpoint with monthly quota limits.',
          warningUrl: 'https://z.ai/subscribe',
          warningUrlLabel: 'Subscribe',
        },
      ],
    },
  }),

  // --- External tool integrations ------------------------------------------
  // This is a list-backed global-state domain. `/config` delegates editing to
  // the existing `/tools` form so the catalog owns discoverability while the
  // tool dashboard remains the single editor for per-integration toggles.
  surfacedSetting({
    key: GlobalStateKey.DISABLED_TOOLS,
    schema: z.array(z.string()).prefault([]),
    title: 'Tool integrations',
    description:
      'Enable or disable external tool integration groups used by agent tool resolution.',
    category: 'tools',
    slots: sameSlot('globalState'),
    honoredBy: everyHost(
      'src/tools/toolAvailability.ts',
      TOOL_AVAILABILITY_RUNTIME_REACHABILITY,
    ),
    openForm: 'tools',
    surfaces: { cliConfig: true },
  }),
  surfacedSetting({
    key: WorkspaceStateKey.TOOL_PATH_PROTECTION_ENABLED,
    schema: z.boolean().prefault(DEFAULT_TOOL_PATH_PROTECTION_ENABLED),
    title: 'Restrict tool paths to the working directory',
    description:
      'Keep file-reading, editing, search, diagnostics, and PDF tools inside the active working directory. Turn this off only when an agent must use arbitrary filesystem paths.',
    category: 'tools',
    slots: sameSlot('workspaceState'),
    honoredBy: everyHost(
      'src/tools/pathResolution.ts',
      TOOL_PATH_PROTECTION_RUNTIME_REACHABILITY,
    ),
    surfaces: { settingsView: 'approval', cliConfig: true },
  }),
];

// ============================================================================
// Derived views — every list below is a filter, never hand-maintained
// ============================================================================

/** Every catalog row, config-tree and state-backed. */
export const ALL_SETTINGS: readonly StateSettingEntry[] = [
  ...CORE_SETTINGS,
  ...STATE_SETTINGS,
];

const STATE_SETTINGS_BY_KEY: ReadonlyMap<string, StateSettingEntry> = new Map(
  STATE_SETTINGS.map((entry) => [entry.key, entry]),
);

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

/** Look up a state-backed catalog entry by its canonical `texra.*` key. */
export function stateSettingByKey(key: string): StateSettingEntry | undefined {
  return STATE_SETTINGS_BY_KEY.get(key);
}

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
 * The `/config` roster: every row the CLI panel renders, across both catalog
 * tiers. `surfaces.cliConfig` is the single predicate, so a row can be honored
 * by the CLI runtime without being editable there (and the guardrail suite
 * still demands runtime-reachability evidence for the ones that are).
 */
export const CLI_STATE_SETTINGS: readonly SurfacedSettingEntry[] =
  SURFACED_SETTINGS.filter((entry) => entry.surfaces.cliConfig === true);

/**
 * Canonical `texra.*` keys the CLI reads or writes in `.texra/config.json` —
 * the unknown-key whitelist's catalog half. A config-backed row belongs when
 * the CLI runtime honors it or the catalog records an exceptional CLI writer.
 */
export const CLI_CONFIG_SLOT_KEYS: readonly string[] = ALL_SETTINGS.filter(
  (entry) =>
    entry.slots.cli === 'config' &&
    (entry.honoredBy.cli !== undefined || entry.writtenBy?.cli !== undefined),
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

/** Whether a setting's schema is a boolean (used to classify edit affordance). */
export function settingIsBoolean(entry: StateSettingEntry): boolean {
  return settingSchemaWithoutPrefault(entry) instanceof z.ZodBoolean;
}

/** Whether a setting's schema is a string (free-text edit affordance). */
export function settingIsString(entry: StateSettingEntry): boolean {
  return settingSchemaWithoutPrefault(entry) instanceof z.ZodString;
}

/** Whether a setting's schema is a number (numeric free-text edit affordance). */
export function settingIsNumber(entry: StateSettingEntry): boolean {
  return settingSchemaWithoutPrefault(entry) instanceof z.ZodNumber;
}
