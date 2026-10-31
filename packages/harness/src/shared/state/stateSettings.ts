// Third-party imports
import { Effect, Schema } from 'effect';

// Local imports - shared constants & state keys
import {
  APPROVAL_POLICY_CONFIG_KEY,
  APPROVAL_POLICY_DEFAULT,
  ApprovalPolicySchema,
} from '@shared/approvalPolicy';
import {
  ActiveSkillSourceScopeSchema,
  AGENT_SKILLS_CONFIG_KEY,
  AGENT_SKILLS_ENABLED_DEFAULT,
  BASH_APPROVAL_CONFIG_KEY,
  CHILD_RUN_CONCURRENCY_BUDGET_CONFIG_KEY,
  DEBUG_MODE_KEY,
  TOOL_EDIT_APPROVAL_CONFIG_KEY,
  WorkspaceAgentsSelectionSchema,
  AgentSkillsEnabledSchema,
  HiddenCustomAgentKeysSchema,
  CHATGPT_CODEX_CONTEXT_WINDOW_SETTING,
  CHILD_RUN_CONCURRENCY_BUDGET_SETTING,
  GOAL_MAX_COST_SETTING,
  MODEL_COMPACTION_THRESHOLD_SETTING,
  MODEL_RETRY_MAX_ATTEMPTS_SETTING,
  RESUME_ON_OPEN_SETTING,
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

const DEFAULT_GIT_AUTHOR_NAME = 'texra-ai';
const DEFAULT_GIT_AUTHOR_EMAIL = 'texra-ai@users.noreply.github.com';

/**
 * Keep file-oriented tools inside the active working directory unless the
 * user explicitly grants them access to arbitrary filesystem paths.
 */
const DEFAULT_TOOL_PATH_PROTECTION_ENABLED = true;

/**
 * The settings catalog, by owner. This module declares the row shape and the
 * harness's own rows (model, approvals, retries, compaction, concurrency,
 * skills, logging). An app declares its rows (its plugins' among them)
 * beside its code, and `settingsCatalog` puts them after these.
 *
 * A row carries what a setting is: its key, its schema with the default, where
 * the value is stored (`slot`: `config` / `workspaceState` / `repoState` /
 * `globalState`, the same on every host) and its display copy. Where an app
 * shows a row is the app's: TeXRA keeps that beside its own rows
 * (`packages/texra/src/shared/settingsView/settingSurfaces.ts`).
 */

/**
 * Storage slot a setting is read from / written to. `repoState` is shared by
 * every checkout of one git repository (keyed by its root in the global
 * database), so a repository has one value on every host and in every
 * worktree.
 */
export type SettingStore =
  'config' | 'workspaceState' | 'repoState' | 'globalState';

export interface StateSettingEntry {
  /** The row's key, relative to its catalog's namespace (`memory.enabled`),
   *  which the stores add (`<namespace>.memory.enabled`). */
  readonly key: string;
  /**
   * The row's schema, carrying both validation and the decoding default
   * applied when the key is absent: decoding `undefined` yields that default.
   */
  readonly schema: Schema.Codec<unknown, unknown>;
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
  /**
   * Per-value descriptions for an enum setting, aligned 1:1 with the schema's
   * enum options (a host's settings UI derives them). The option *values* are
   * derived from the schema, not restated here.
   */
  readonly enumDescriptions?: readonly string[];
  /** Display labels for enum options, aligned 1:1 with the schema options. */
  readonly enumLabels?: readonly string[];
}

// ============================================================================
// Row builders
// ============================================================================

/** A global provider knob with no settings-view row (`.texra/config.json`). */
function configToggle(on: boolean, description: string) {
  const schema = Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(on)),
  );
  return { configTarget: 'global', schema, description } as const;
}

/** A provider toggle: a boolean every host stores in GlobalState. */
function globalProviderToggle(opts: {
  readonly key: string;
  readonly default: boolean;
  readonly title: string;
  readonly description: string;
}): StateSettingEntry {
  return {
    key: opts.key,
    schema: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(opts.default)),
    ),
    title: opts.title,
    description: opts.description,
    category: 'model',
    slot: 'globalState',
  };
}

// ============================================================================
// Core (config-tree) rows
// ============================================================================

/**
 * Every config-file-backed setting, keyed by its dotted path.
 *
 * All three hosts read `.texra/config.json` and that storage is flat, so the
 * key and the slot are derived rather than restated; a row carries the schema
 * (with its `withDecodingDefault` default) and the copy — exactly the shape
 * every state-backed row below already uses.
 *
 * The record's own declaration order is the catalog order.
 */
const HARNESS_CONFIG_ROWS: Record<
  string,
  Omit<StateSettingEntry, 'key' | 'slot'>
> = {
  [CHILD_RUN_CONCURRENCY_BUDGET_CONFIG_KEY]: {
    schema: Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(CHILD_RUN_CONCURRENCY_BUDGET_SETTING.min),
    )
      .check(
        Schema.isLessThanOrEqualTo(CHILD_RUN_CONCURRENCY_BUDGET_SETTING.max),
      )
      .pipe(
        Schema.withDecodingDefault(
          Effect.succeed(CHILD_RUN_CONCURRENCY_BUDGET_SETTING.defaultValue),
        ),
      ),
    title: 'Agents at once',
    description: CHILD_RUN_CONCURRENCY_BUDGET_SETTING.description,
    category: 'agents',
  },
  // Global: how one person wants their windows to open.
  [RESUME_ON_OPEN_SETTING.configKey]: {
    schema: Schema.Literals(RESUME_ON_OPEN_SETTING.values).pipe(
      Schema.withDecodingDefault(
        Effect.succeed(RESUME_ON_OPEN_SETTING.defaultValue),
      ),
    ),
    configTarget: 'global',
    title: 'Interrupted tasks',
    description: RESUME_ON_OPEN_SETTING.description,
    category: 'agents',
    enumLabels: ['Ask', 'Resume automatically'],
  },
  // Global: a committed project config must not raise or remove the user's cap.
  [GOAL_MAX_COST_SETTING.configKey]: {
    schema: Schema.Number.check(
      Schema.isGreaterThanOrEqualTo(GOAL_MAX_COST_SETTING.min),
    )
      .check(Schema.isLessThanOrEqualTo(GOAL_MAX_COST_SETTING.max))
      .pipe(
        Schema.withDecodingDefault(
          Effect.succeed(GOAL_MAX_COST_SETTING.defaultValue),
        ),
      ),
    configTarget: 'global',
    title: 'Goal spend cap (USD)',
    description: GOAL_MAX_COST_SETTING.description,
    category: 'tools',
  },
  // The provider toggles below are `configTarget: 'global'`: they describe how
  // you talk to a provider, not a property of one project. Writes go to the
  // global file past the open-workspace write guard; reads stay merged, so a
  // workspace override stays honored (stranded values: #11173). Only
  // server-side state is a user choice (data retention); the transport knobs
  // have no settings-view row and live in `.texra/config.json`.
  'model.gpt5ReasoningSummary': configToggle(
    false,
    "Show the model's reasoning steps alongside its output when using GPT-5 models. Requires an OpenAI account with access to reasoning features.",
  ),
  'model.useGoogleInteractionsServerState': {
    schema: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
    ),
    configTarget: 'global',
    title: 'Server-side conversation state',
    description:
      "Store Google Interactions conversation state on Google's servers via previous_interaction_id chaining, sending only the new turn each round. Google then retains the conversation for a limited period to enable chaining. Enabled by default. Disable to keep conversations off Google's servers — stateless mode resends the full transcript each round (store:false).",
    category: 'model',
  },
  'model.useGoogleBackgroundResponses': configToggle(
    false,
    'Run text-only Google generations as background Interactions (submit + poll) instead of one long streamed request. Requires server-side conversation state and a model that supports background execution. Off by default; unsupported models fall back automatically.',
  ),
  'model.useBackgroundResponses': configToggle(
    true,
    'Keep long-running OpenAI requests alive in the background (polling) instead of timing out after 10 minutes. Applies automatically to GPT models running a text-only agent (one without tools); ignored otherwise. Disable to fall back to synchronous streaming requests.',
  ),
  'model.openaiFastTier': configToggle(
    false,
    "Send OpenAI requests on OpenAI's fast service tier, for models that offer it: faster responses at a higher per-token price, which run costs reflect.",
  ),
  'model.openaiParallelToolCalls': configToggle(
    true,
    'Let OpenAI models use multiple tools at the same time for faster results. Enabled by default; disable for models that require sequential tool run.',
  ),
  // No `configTarget`: both runtime readers resolve the *merged* config value
  // through `Settings.get`, so narrowing the row to the global scope would
  // hide (and block writes to) a workspace override the runtime honors.
  [MODEL_COMPACTION_THRESHOLD_SETTING.configKey]: {
    schema: Schema.Number.check(
      Schema.isGreaterThanOrEqualTo(MODEL_COMPACTION_THRESHOLD_SETTING.min),
    )
      .check(Schema.isLessThanOrEqualTo(MODEL_COMPACTION_THRESHOLD_SETTING.max))
      .pipe(
        Schema.withDecodingDefault(
          Effect.succeed(MODEL_COMPACTION_THRESHOLD_SETTING.defaultValue),
        ),
      ),
    title: 'Compaction threshold',
    description: MODEL_COMPACTION_THRESHOLD_SETTING.description,
    category: 'model',
  },
  [MODEL_RETRY_MAX_ATTEMPTS_SETTING.configKey]: {
    schema: Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(MODEL_RETRY_MAX_ATTEMPTS_SETTING.min),
    )
      .check(Schema.isLessThanOrEqualTo(MODEL_RETRY_MAX_ATTEMPTS_SETTING.max))
      .pipe(
        Schema.withDecodingDefault(
          Effect.succeed(MODEL_RETRY_MAX_ATTEMPTS_SETTING.defaultValue),
        ),
      ),
    title: 'Automatic retries',
    description: MODEL_RETRY_MAX_ATTEMPTS_SETTING.description,
    category: 'model',
  },
  'chatgptCodex.preferSubscription': {
    schema: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
    ),
    description:
      'Prefer your signed-in ChatGPT subscription for Codex-eligible OpenAI models instead of API-key routing. Experimental. Subscription routing takes the input window the Codex backend grants each model; use chatgptCodex.contextWindowK to override it.',
  },
  [CHATGPT_CODEX_CONTEXT_WINDOW_SETTING.configKey]: {
    schema: Schema.NullOr(
      Schema.Int.check(
        Schema.isGreaterThanOrEqualTo(CHATGPT_CODEX_CONTEXT_WINDOW_SETTING.min),
      ).check(
        Schema.isLessThanOrEqualTo(CHATGPT_CODEX_CONTEXT_WINDOW_SETTING.max),
      ),
    ).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
    title: 'Subscription input token budget (K tokens)',
    description: CHATGPT_CODEX_CONTEXT_WINDOW_SETTING.description,
    category: 'model',
  },
  'xaiGrok.preferSubscription': {
    schema: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
    ),
    description:
      'Prefer your signed-in Grok (xAI SuperGrok) account for xAI models instead of API-key routing. Experimental. Uses the public Grok CLI OAuth client; xAI may change or revoke that registration without notice.',
  },
  maxImageDimension: {
    schema: Schema.Int.check(Schema.isGreaterThanOrEqualTo(100))
      .check(Schema.isLessThanOrEqualTo(10000))
      .pipe(Schema.withDecodingDefault(Effect.succeed(2000))),
    description:
      'Maximum dimension (width or height) in pixels for images before resizing. Images larger than this will be resized to fit within this dimension while maintaining aspect ratio.',
  },
  // The launcher's commit picker reads the count through the host snapshot on
  // both GUI hosts; the CLI only writes it, through the setup assistant's
  // `update_config`.
  'git.numberOfCommitsToShow': {
    schema: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
      .check(Schema.isLessThanOrEqualTo(1000))
      .pipe(Schema.withDecodingDefault(Effect.succeed(20))),
    description:
      'Number of recent commits to show in the commit selection dropdown',
  },
  'audio.soxPath': {
    schema: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(''))),
    description: 'Path to the SoX executable. Overrides automatic detection.',
  },
  [DEBUG_MODE_KEY]: {
    schema: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
    ),
    description:
      "Show the transcript's verbose tier: debug-level rows and their payload detail. The log surfaces filter themselves (the Output view's own level filter, the desktop log file, the CLI's --verbose/--quiet).",
  },
  'debug.saveModelIO': {
    schema: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
    ),
    description:
      'Save what is sent to and received from the model: the request messages and raw responses as JSON, plus the final input prompt as XML.',
  },
  [AGENT_SKILLS_CONFIG_KEY]: {
    schema: AgentSkillsEnabledSchema.pipe(
      Schema.withDecodingDefault(Effect.succeed(AGENT_SKILLS_ENABLED_DEFAULT)),
    ),
    title: 'Enable skills for agents',
    description:
      'Expose enabled built-in and imported skills to agent prompts. Skills are off by default.',
    category: 'tools',
  },
  [TOOL_EDIT_APPROVAL_CONFIG_KEY]: {
    schema: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
    ),
    title: 'Require approval for file edits',
    description:
      'Show a diff and wait for your approval before an agent changes a project file.',
    category: 'tools',
    configTarget: 'local',
  },
  [BASH_APPROVAL_CONFIG_KEY]: {
    schema: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
    ),
    title: 'Require approval for shell commands',
    description: 'Wait for your approval before an agent runs a shell command.',
    category: 'tools',
    configTarget: 'local',
  },
};

/**
 * Config-file-backed rows from a record keyed by dotted path: the key and the
 * uniform `config` slot are derived, not restated. The record's declaration
 * order is the catalog order.
 */
export function configTreeRows(
  rows: Readonly<Record<string, Omit<StateSettingEntry, 'key' | 'slot'>>>,
): StateSettingEntry[] {
  return Object.entries(rows).map(([key, row]) => ({
    ...row,
    key,
    slot: 'config',
  }));
}

/**
 * `approvalPolicy`, written out beside the config tree because the
 * approval-policy module owns its schema and the tolerant parsing of
 * typed-in spellings.
 */
const APPROVAL_POLICY_SETTING: StateSettingEntry = {
  key: APPROVAL_POLICY_CONFIG_KEY,
  // Strict on purpose: `settingEnumOptions` derives the dropdown from a
  // literal-list row, and the tolerant spelling belongs to
  // `parseApprovalPolicy`, which every reader of typed-in text (the
  // env var, `--approval-policy`, `/approval`, the dropdown) calls before
  // a value ever reaches this row.
  schema: ApprovalPolicySchema.pipe(
    Schema.withDecodingDefault(Effect.succeed(APPROVAL_POLICY_DEFAULT)),
  ),
  title: 'Approval policy',
  description:
    'Whether agents ask before running shell commands and editing files. Under Ask, the toggles below choose which of the two need your approval.',
  category: 'tools',
  slot: 'config',
  configTarget: 'local',
  enumLabels: ['Block', 'Ask', 'Auto-approve'],
};

// ============================================================================
// State-backed rows
// ============================================================================

const PROVIDER_ENDPOINT_SETTINGS: readonly StateSettingEntry[] =
  PROVIDER_ENDPOINT_STATE_ENTRIES.map(({ endpointKey, displayName }) => ({
    key: endpointKey,
    schema: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(''))),
    title: `${displayName} endpoint`,
    description: `Custom base URL for ${displayName} API requests. Leave empty to use the default endpoint.`,
    category: 'model',
    slot: 'globalState',
  }));

/**
 * Region toggles resolved into `RouteFacts.endpoints`: one row per provider
 * plugin `region`.
 */
const PROVIDER_ROUTING_SETTINGS = PROVIDER_REGION_SETTINGS.map(
  ({ key, default: china, title, description }) =>
    globalProviderToggle({ key, default: china, title, description }),
);

const STATE_SETTINGS: readonly StateSettingEntry[] = [
  // --- Git commit author marking ---------------------------------------------
  {
    key: WorkspaceStateKey.GIT_MARK_COMMITS,
    schema: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
    ),
    title: 'Mark agent commits',
    description:
      'Attribute agent-authored git commits to the agent commit author so they are distinguishable from your own commits.',
    category: 'git',
    slot: 'repoState',
  },
  {
    key: WorkspaceStateKey.GIT_AUTHOR_NAME,
    // `.min(1)` so a blank value is rejected at the write boundary and a
    // legacy blank read falls back (loudly) to the default identity.
    schema: Schema.String.check(Schema.isMinLength(1)).pipe(
      Schema.withDecodingDefault(Effect.succeed(DEFAULT_GIT_AUTHOR_NAME)),
    ),
    title: 'Agent commit author',
    description:
      'Author and committer name used for agent-authored commits when commit marking is enabled.',
    category: 'git',
    slot: 'repoState',
  },
  {
    key: WorkspaceStateKey.GIT_AUTHOR_EMAIL,
    schema: Schema.String.check(Schema.isMinLength(1)).pipe(
      Schema.withDecodingDefault(Effect.succeed(DEFAULT_GIT_AUTHOR_EMAIL)),
    ),
    title: 'Agent commit email',
    description:
      'Author and committer email used for agent-authored commits when commit marking is enabled.',
    category: 'git',
    slot: 'repoState',
  },
  {
    key: WorkspaceStateKey.GIT_WORKTREE_SUPPORT,
    schema: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
    ),
    title: 'Subagent worktrees',
    description:
      'Allow spawned subagents to run in isolated git worktrees so parallel edits do not conflict.',
    category: 'git',
    slot: 'repoState',
  },

  // --- Workspace agents ----------------------------------------------------------
  // Written and read by the agent list and the settings view's agent catalog,
  // which no catalog-driven UI renders.
  {
    key: WorkspaceStateKey.WORKSPACE_AGENTS,
    schema: WorkspaceAgentsSelectionSchema.pipe(
      Schema.withDecodingDefault(Effect.succeed(INHERITED_WORKSPACE_AGENTS)),
    ),
    slot: 'repoState',
  },
  {
    key: WorkspaceStateKey.HIDDEN_CUSTOM_AGENTS,
    schema: HiddenCustomAgentKeysSchema.pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
    ),
    slot: 'repoState',
  },

  // --- Agent coordination ---------------------------------------------
  // Both child-work policy toggles live in `globalState`: they describe how
  // *this user* wants child runs handled, not anything
  // about a particular checkout, so no worktree-scoping need is documented on
  // either row. Before the move the extension smuggled that same intent past a
  // `workspaceState` slot via a worktree-shared key list, while the Node hosts
  // scoped the value per workspace-path hash — one row, two meanings.
  {
    key: GlobalStateKey.ALLOW_ORCHESTRATOR_KILL,
    schema: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
    ),
    title: 'Let a task stop its agents',
    description:
      'Allow a task to stop the agents it started once they are no longer needed.',
    category: 'agents',
    slot: 'globalState',
  },
  {
    key: GlobalStateKey.DETACH_SUBAGENTS_ON_STOP,
    schema: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
    ),
    title: 'Keep agents running',
    description: "Let a task's agents continue when the task is stopped.",
    category: 'agents',
    slot: 'globalState',
  },

  // --- Memory ---------------------------------------------------------------
  // Every host's runtime honors the key through the `memory` entry of the
  // memory-workflow plugin's `injectedWhen` (`@tools/plugins`).
  {
    key: GlobalStateKey.MEMORY_ENABLED,
    schema: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
    ),
    title: 'Enable memory for chat agents',
    description: 'Remember useful details across chat sessions.',
    category: 'tools',
    slot: 'globalState',
  },

  // --- Code mode -------------------------------------------------------------
  // The codemode plugin's `injectedWhen` reads the key to inject `script`;
  // the step reads it to send the model `script` and the run's own tools
  // alone, recorded per tool on its `tools.offered` row.
  {
    key: GlobalStateKey.SCRIPT_ONLY,
    schema: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
    ),
    title: 'Script-only tools',
    description:
      'Send chat agents the script tool and their own tools alone: every other tool is called from inside a script. Off by default while the comparison against direct tool calls runs.',
    category: 'agents',
    slot: 'globalState',
  },

  // --- OpenAI WebSocket transport (experimental) -----------------------------
  {
    key: GlobalStateKey.WEBSOCKET_OPENAI,
    schema: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
    ),
    title: 'OpenAI WebSocket',
    description:
      'EXPERIMENTAL: use the persistent WebSocket transport for OpenAI Responses requests (lower latency for tool-use loops), and let the ChatGPT-subscription Codex backend attempt WebSocket. Off by default.',
    category: 'model',
    slot: 'globalState',
  },

  // --- Provider endpoints -----------------------------------------------------
  ...PROVIDER_ENDPOINT_SETTINGS,

  // --- Model picker preferences ---------------------------------------------
  {
    key: GlobalStateKey.HELPER_MODEL,
    schema: Schema.String.check(Schema.isMinLength(1)).pipe(
      Schema.withDecodingDefault(Effect.succeed(DEFAULT_HELPER_MODEL)),
    ),
    title: 'Helper model',
    description:
      'Model used for auxiliary tasks: instruction polishing, merges, and session descriptions.',
    category: 'model',
    slot: 'globalState',
  },
  {
    key: GlobalStateKey.PREFER_SHORT_MODEL_NAMES,
    schema: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
    ),
    title: 'Prefer short model names',
    description: 'Show compact model names in pickers.',
    category: 'model',
    slot: 'globalState',
  },

  // --- Provider routing & region toggles --------------------------------------
  globalProviderToggle({
    key: GlobalStateKey.KIMI_CODE_PREFER,
    default: false,
    title: 'Kimi Code subscription',
    description:
      'Route dual-backend Kimi models (K3) through the Kimi Code coding endpoint when a Kimi Code API key is set. The two coding-only models always use the key. When off, K3 uses the Moonshot open platform.',
  }),
  ...PROVIDER_ROUTING_SETTINGS,
  globalProviderToggle({
    key: GlobalStateKey.GLM_CODING_PLAN,
    default: false,
    title: 'GLM Coding Plan',
    description:
      'Use a Coding Plan subscription key instead of pay-as-you-go. Routes requests through the coding-specific endpoint with monthly quota limits.',
  }),

  {
    key: WorkspaceStateKey.DISABLED_SKILLS,
    schema: Schema.Array(QualifiedSkillNameSchema).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
    ),
    title: 'Skills',
    description: 'Enable or disable individual skills in this workspace.',
    category: 'tools',
    slot: 'config',
  },
  {
    key: WorkspaceStateKey.DISABLED_SKILL_SOURCES,
    schema: Schema.Array(ActiveSkillSourceScopeSchema).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
    ),
    title: 'Skill sources',
    description: 'Enable or disable skill source groups in this workspace.',
    category: 'tools',
    slot: 'config',
  },
  {
    key: WorkspaceStateKey.TOOL_PATH_PROTECTION_ENABLED,
    schema: Schema.Boolean.pipe(
      Schema.withDecodingDefault(
        Effect.succeed(DEFAULT_TOOL_PATH_PROTECTION_ENABLED),
      ),
    ),
    title: 'Restrict tool paths to the working directory',
    description:
      'Keep file-reading, editing, search, diagnostics, and PDF tools inside the active working directory. Turn this off only when an agent must use arbitrary filesystem paths.',
    category: 'tools',
    slot: 'workspaceState',
  },
];

// ============================================================================
// The catalog — the harness's rows followed by an app's
// ============================================================================

/** The harness's own rows, in catalog order: config-file-backed, then state-backed. */
const HARNESS_SETTINGS: readonly StateSettingEntry[] = [
  ...configTreeRows(HARNESS_CONFIG_ROWS),
  APPROVAL_POLICY_SETTING,
  ...STATE_SETTINGS,
];

/** One settings catalog: its rows and the lookups the stores read from them. */
export interface SettingsCatalog {
  /** The app's prefix on every stored key (`texra`): the config and state
   *  stores write a row's relative key as `<namespace>.<key>`. */
  readonly namespace: string;
  /** Every row, in catalog order. */
  readonly rows: readonly StateSettingEntry[];
  /** Look up any row, config-file-backed or state-backed, by its key. */
  readonly byKey: (key: string) => StateSettingEntry | undefined;
  /** Look up a row by its stored key, as a store lists it. */
  readonly byStoredKey: (storedKey: string) => StateSettingEntry | undefined;
  /**
   * A fresh copy of a config-file-backed row's default, or `undefined` for a
   * key no such row owns: what every `ConfigProvider` answers for an absent
   * key. Parsed defaults are memoized
   * because this is on the read path of every absent setting; object values
   * are cloned so a caller cannot mutate the catalog's own default.
   */
  readonly configDefault: (key: string) => unknown;
}

/** The harness's rows, then `rows` (an app's own, its plugins' included),
 *  stored under `namespace`. A key declared twice is a defect and throws. */
export function settingsCatalog(options: {
  readonly namespace: string;
  readonly rows: readonly StateSettingEntry[];
}): SettingsCatalog {
  const rows = [...HARNESS_SETTINGS, ...options.rows];
  const byKey = new Map<string, StateSettingEntry>();
  for (const row of rows) {
    if (byKey.has(row.key)) {
      throw new Error(`Setting ${row.key} is declared twice.`);
    }
    byKey.set(row.key, row);
  }
  const defaults = new Map<string, unknown>();
  return {
    namespace: options.namespace,
    rows,
    byKey: (key) => byKey.get(key),
    byStoredKey: (storedKey) =>
      storedKey.startsWith(`${options.namespace}.`)
        ? byKey.get(storedKey.slice(options.namespace.length + 1))
        : undefined,
    configDefault: (key) => {
      const entry = byKey.get(key);
      if (entry?.slot !== 'config') return undefined;
      if (!defaults.has(key)) {
        defaults.set(key, Schema.decodeUnknownSync(entry.schema)(undefined));
      }
      const value = defaults.get(key);
      return value !== null && typeof value === 'object'
        ? structuredClone(value)
        : value;
    },
  };
}
