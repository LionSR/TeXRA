// Third-party imports
import { Effect, Predicate, Schema } from 'effect';

// Local imports - shared constants & state keys
import {
  APPROVAL_POLICY_DEFAULT,
  ApprovalPolicySchema,
} from '@shared/approvalPolicy';
import {
  ActiveSkillSourceScopeSchema,
  WorkspaceAgentsSelectionSchema,
  HiddenCustomAgentKeysSchema,
  INHERITED_WORKSPACE_AGENTS,
  QualifiedSkillNameSchema,
} from '@shared/schemas';
import {
  PROVIDER_ENDPOINT_SETTINGS,
  PROVIDER_REGION_SETTINGS,
} from '@shared/state/providerSettings';
import { WorkspaceStateKey } from '@shared/state/stateKeys';

/**
 * The settings catalog, by owner. This module declares the row shape and the
 * harness's own rows (model, approvals, retries, compaction, concurrency,
 * skills, logging). An app declares its rows (its plugins' among them)
 * beside its code, and `settingsCatalog` puts them after these.
 *
 * A row carries what a setting is: its key, its schema with the default and
 * any bounds, where the value is stored (`slot`: `config` / `workspaceState` /
 * `repoState` / `globalState`, the same on every host) and its display copy.
 * The row is also the handle a reader passes to `Settings`, which types the
 * value by the row's schema. Where an app shows a row is the app's: TeXRA
 * keeps that beside its own rows
 * (`packages/texra/src/shared/settingsView/settingSurfaces.ts`).
 */

/**
 * Storage slot a setting is read from / written to. `repoState` is shared by
 * every checkout of one git repository (keyed by its root in the global
 * database), so a repository has one value on every host and in every
 * worktree.
 */
export type SettingStore =
  | 'config'
  | 'workspaceState'
  | 'repoState'
  | 'globalState';

/** One setting, whose schema decodes its stored value to an `A`. */
export interface SettingRow<A = unknown> {
  /** The row's key, relative to its catalog's namespace (`memory.enabled`),
   *  which the stores add (`<namespace>.memory.enabled`). */
  readonly key: string;
  /**
   * The row's schema, carrying validation, any bounds, and the decoding
   * default applied when the key is absent: decoding `undefined` yields that
   * default.
   */
  readonly schema: Schema.Codec<A, unknown>;
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
// Config-file-backed rows
// ============================================================================

/**
 * The sentinel and the ceiling of the child-run concurrency budget: `0`
 * sizes the budget to this machine's core count at runtime, the same
 * "special value inside the range" shape as the compaction threshold's
 * `0 = disable`, so the number widget needs no second mode.
 */
export const CHILD_RUN_CONCURRENCY_BUDGET_RANGE = Object.freeze({
  auto: 0,
  max: 100,
} as const);

/** How many native child model conversations one session runs at once. */
export const CHILD_RUN_CONCURRENCY_BUDGET_SETTING = {
  key: 'childRunConcurrencyBudget',
  slot: 'config',
  schema: Schema.Int.check(
    Schema.isBetween({
      minimum: CHILD_RUN_CONCURRENCY_BUDGET_RANGE.auto,
      maximum: CHILD_RUN_CONCURRENCY_BUDGET_RANGE.max,
    }),
  ).pipe(
    Schema.withDecodingDefault(
      Effect.succeed(CHILD_RUN_CONCURRENCY_BUDGET_RANGE.auto),
    ),
  ),
  title: 'Agents at once',
  description:
    "Maximum number of agents one task may run at once in the background; a script's agent() calls also run at most this many at once. 0 (the default) sizes it to this machine's CPU count. Agents beyond the budget wait for a slot to free.",
  category: 'agents',
} as const satisfies SettingRow<number>;

/**
 * What a goal's rounds may spend before it pauses instead of starting another
 * round; `0` disables the cap. Read when the goal launches, into its script.
 * Global: a committed project config must not raise or remove the user's cap.
 */
export const GOAL_MAX_COST_SETTING = {
  key: 'goal.maxCostUsd',
  slot: 'config',
  schema: Schema.Number.check(
    Schema.isBetween({ minimum: 0, maximum: 10_000 }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed(5))),
  configTarget: 'global',
  title: 'Goal spend cap (USD)',
  description:
    'Spend in US dollars, across its rounds, at which an autonomous goal pauses instead of starting another round. Raise it, then run the goal again to continue. Set to 0 to remove the cap (not recommended with auto-approve on your own API key).',
  category: 'tools',
} as const satisfies SettingRow<number>;

/**
 * The script module whose `goal` export a plan run as a goal calls. The
 * default is the goal plugin's own module; a `scriptModules` entry of any
 * plugin that is on may replace it. Read when the goal launches. Global, as
 * the cap is: the strategy is what checks the cap, so a committed project
 * config must not pick one that ignores it.
 */
export const GOAL_STRATEGY_SETTING = {
  key: 'goal.strategy',
  slot: 'config',
  schema: Schema.String.check(
    Schema.isPattern(/^builtIn:[A-Za-z0-9_-]+$/),
  ).pipe(Schema.withDecodingDefault(Effect.succeed('builtIn:goal'))),
  configTarget: 'global',
  description:
    "The script module a plan run as a goal runs, by its import specifier (`builtIn:<module>`): its `goal(objective, { maxCostUsd })` export decides the rounds, what context each starts from and when to stop, and resolves to the goal's result. Defaults to the goal plugin's own module.",
} as const satisfies SettingRow<string>;

// The provider toggles below are `configTarget: 'global'`: they describe how
// you talk to a provider, not a property of one project. Writes go to the
// global file past the open-workspace write guard, and reads take the global
// value only: a project file's value for one is ignored (#11173). Server-side
// state (data retention) and the fast tier (price) are user choices with a
// settings-view row; the transport knob has none and is set in the global
// `config.json`.

export const GOOGLE_INTERACTIONS_SERVER_STATE_SETTING = {
  key: 'model.useGoogleInteractionsServerState',
  slot: 'config',
  schema: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  configTarget: 'global',
  title: 'Server-side conversation state',
  description:
    "Store Interactions conversation state on Google's servers (send only the new turn each round; Google retains the conversation for a limited period to enable chaining). Disable to keep conversations off Google's servers and resend the full transcript each round.",
  category: 'model',
} as const satisfies SettingRow<boolean>;

export const GOOGLE_BACKGROUND_RESPONSES_SETTING = {
  key: 'model.useGoogleBackgroundResponses',
  slot: 'config',
  schema: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  configTarget: 'global',
  description:
    'Run text-only Google generations as background Interactions (submit + poll) instead of one long streamed request. Requires server-side conversation state and a model that supports background execution. Off by default; unsupported models fall back automatically.',
} as const satisfies SettingRow<boolean>;

export const OPENAI_FAST_TIER_SETTING = {
  key: 'model.openaiFastTier',
  slot: 'config',
  schema: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  configTarget: 'global',
  title: 'Fast mode',
  description:
    "Send OpenAI requests on OpenAI's fast service tier, for models that offer it: faster responses at a higher per-token price, which run costs reflect.",
  category: 'model',
} as const satisfies SettingRow<boolean>;

/**
 * The share of the model's context window that triggers automatic
 * compaction; `0` disables it. No `configTarget`: both runtime readers
 * resolve the merged config value through `Settings.get`, so narrowing the
 * row to the global scope would hide (and block writes to) a workspace
 * override the runtime honors.
 */
export const MODEL_COMPACTION_THRESHOLD_SETTING = {
  key: 'model.compactionThresholdPercent',
  slot: 'config',
  schema: Schema.Number.check(
    Schema.isBetween({ minimum: 0, maximum: 100 }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed(75))),
  title: 'Compaction threshold',
  description:
    "When the conversation reaches this percentage of the model's context limit, earlier messages are summarized automatically to free up space. Lower values trigger summarization sooner. Set to 0 to disable.",
  category: 'model',
} as const satisfies SettingRow<number>;

/** The number of automatic retries after the initial model request. */
export const MODEL_RETRY_MAX_ATTEMPTS_SETTING = {
  key: 'model.retry.maxAttempts',
  slot: 'config',
  schema: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 })).pipe(
    Schema.withDecodingDefault(Effect.succeed(2)),
  ),
  title: 'Automatic retries',
  description:
    'Additional automatic retries after the initial model request (0–5). A resumed request keeps the retries it already used.',
  category: 'model',
} as const satisfies SettingRow<number>;

export const CHATGPT_PREFER_SUBSCRIPTION_SETTING = {
  key: 'chatgptCodex.preferSubscription',
  slot: 'config',
  schema: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  description:
    'Prefer your signed-in ChatGPT subscription for Codex-eligible OpenAI models instead of API-key routing. Experimental. Subscription routing takes the input window the Codex backend grants each model; use chatgptCodex.contextWindowK to override it.',
} as const satisfies SettingRow<boolean>;

/**
 * The ChatGPT-subscription input budget; unset, each model takes the window
 * the Codex backend grants it.
 *
 * The stored unit is **thousands of tokens**, and the key says so. Every
 * budget in play is a round multiple of 1000 (272K, 400K, 872K), so a raw
 * token count is three zeros nobody wants to type and an off-by-1000 typo
 * lands inside the valid range instead of being rejected: `872` entered for
 * 872,000 is a legal 872-token budget that puts every request over the limit,
 * and the failure then names a number the user never meant to set.
 */
export const CHATGPT_CODEX_CONTEXT_WINDOW_SETTING = {
  key: 'chatgptCodex.contextWindowK',
  slot: 'config',
  schema: Schema.NullOr(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 872 })),
  ).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  title: 'Subscription input token budget (K tokens)',
  description:
    "Input token budget for ChatGPT-subscription (Codex) routing, in thousands of tokens, mirroring Codex CLI's model_context_window. Unset, each model takes the window the Codex backend grants it (500 for GPT-6.1 Sol, 272 for the others); a value overrides it for every model, up to 872 (872,000 tokens). Automatic compaction may run earlier according to the separate compaction threshold. The model's output budget is added when displaying the total context window. The OpenAI backend enforces the real per-account limit — values above what your subscription allows fail and trigger compaction recovery.",
  category: 'model',
} as const satisfies SettingRow<number | null>;

export const XAI_PREFER_SUBSCRIPTION_SETTING = {
  key: 'xaiGrok.preferSubscription',
  slot: 'config',
  schema: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  description:
    'Prefer your signed-in Grok (xAI SuperGrok) account for xAI models instead of API-key routing. Experimental. Uses the public Grok CLI OAuth client; xAI may change or revoke that registration without notice.',
} as const satisfies SettingRow<boolean>;

export const MAX_IMAGE_DIMENSION_SETTING = {
  key: 'maxImageDimension',
  slot: 'config',
  schema: Schema.Int.check(
    Schema.isBetween({ minimum: 100, maximum: 10_000 }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed(2000))),
  description:
    'Maximum dimension (width or height) in pixels for images before resizing. Images larger than this will be resized to fit within this dimension while maintaining aspect ratio.',
} as const satisfies SettingRow<number>;

/**
 * The launcher's commit picker reads the count through the host snapshot on
 * both GUI hosts; the CLI only writes it, through the setup assistant's
 * `update_config`.
 */
export const GIT_COMMITS_TO_SHOW_SETTING = {
  key: 'git.numberOfCommitsToShow',
  slot: 'config',
  schema: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: 1000 }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed(20))),
  description:
    'Number of recent commits to show in the commit selection dropdown',
} as const satisfies SettingRow<number>;

export const SOX_PATH_SETTING = {
  key: 'audio.soxPath',
  slot: 'config',
  schema: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(''))),
  description: 'Path to the SoX executable. Overrides automatic detection.',
} as const satisfies SettingRow<string>;

/**
 * Transcript verbosity, its one meaning: the debug tier of the transcript
 * view and the detail of the payloads it shows. A log surface's own level
 * filter decides what that surface prints, so no producer reads this row to
 * widen or narrow a log; only a view build does.
 */
export const DEBUG_MODE_SETTING = {
  key: 'logger.debugMode',
  slot: 'config',
  schema: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  description:
    "Show the transcript's verbose tier: debug-level rows and their payload detail. The log surfaces filter themselves (the Output view's own level filter, the desktop log file, the CLI's --verbose/--quiet).",
} as const satisfies SettingRow<boolean>;

export const SAVE_MODEL_IO_SETTING = {
  key: 'debug.saveModelIO',
  slot: 'config',
  schema: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  description:
    'Save what is sent to and received from the model: the request messages and raw responses as JSON, plus the final input prompt as XML.',
} as const satisfies SettingRow<boolean>;

/** Whether agents receive the skills discovered from every source. */
export const AGENT_SKILLS_ENABLED_SETTING = {
  key: 'skills.enabled',
  slot: 'config',
  schema: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  title: 'Enable skills for agents',
  description:
    'Expose enabled built-in and imported skills to agent prompts. Skills are off by default.',
  category: 'tools',
} as const satisfies SettingRow<boolean>;

/**
 * The approval policy. Strict on purpose: `settingEnumOptions` derives the
 * dropdown from a literal-list row, and the tolerant spelling belongs to
 * `parseApprovalPolicy`, which every reader of typed-in text (the env var,
 * `--approval-policy`, `/approval`, the dropdown) calls before a value ever
 * reaches this row.
 */
export const APPROVAL_POLICY_SETTING = {
  key: 'approvalPolicy',
  slot: 'config',
  schema: ApprovalPolicySchema.pipe(
    Schema.withDecodingDefault(Effect.succeed(APPROVAL_POLICY_DEFAULT)),
  ),
  title: 'Approval policy',
  description:
    'Whether agents ask before running shell commands and editing files.',
  category: 'tools',
  configTarget: 'local',
  enumLabels: ['Block', 'Ask', 'Auto-approve'],
} as const satisfies SettingRow<typeof ApprovalPolicySchema.Type>;

export const DISABLED_SKILLS_SETTING = {
  key: 'skills.disabled',
  slot: 'config',
  schema: Schema.Array(QualifiedSkillNameSchema).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  title: 'Skills',
  description: 'Enable or disable individual skills in this workspace.',
  category: 'tools',
} as const satisfies SettingRow<readonly string[]>;

export const DISABLED_SKILL_SOURCES_SETTING = {
  key: 'skills.disabledSources',
  slot: 'config',
  schema: Schema.Array(ActiveSkillSourceScopeSchema).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  title: 'Skill sources',
  description: 'Enable or disable skill source groups in this workspace.',
  category: 'tools',
} as const satisfies SettingRow<
  readonly (typeof ActiveSkillSourceScopeSchema.Type)[]
>;

// ============================================================================
// State-backed rows
// ============================================================================

// --- Git commit author marking ---------------------------------------------

export const GIT_MARK_COMMITS_SETTING = {
  key: 'git.markCommits',
  slot: 'repoState',
  schema: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  title: 'Mark agent commits',
  description:
    'Attribute agent-authored git commits to the agent commit author so they are distinguishable from your own commits.',
  category: 'git',
} as const satisfies SettingRow<boolean>;

export const GIT_AUTHOR_NAME_SETTING = {
  key: 'git.authorName',
  slot: 'repoState',
  // `.min(1)` so a blank value is rejected at the write boundary and a
  // blank read falls back (loudly) to the default identity.
  schema: Schema.String.check(Schema.isMinLength(1)).pipe(
    Schema.withDecodingDefault(Effect.succeed('texra-ai')),
  ),
  title: 'Agent commit author',
  description:
    'Author and committer name used for agent-authored commits when commit marking is enabled.',
  category: 'git',
} as const satisfies SettingRow<string>;

export const GIT_AUTHOR_EMAIL_SETTING = {
  key: 'git.authorEmail',
  slot: 'repoState',
  schema: Schema.String.check(Schema.isMinLength(1)).pipe(
    Schema.withDecodingDefault(
      Effect.succeed('texra-ai@users.noreply.github.com'),
    ),
  ),
  title: 'Agent commit email',
  description:
    'Author and committer email used for agent-authored commits when commit marking is enabled.',
  category: 'git',
} as const satisfies SettingRow<string>;

export const GIT_WORKTREE_SUPPORT_SETTING = {
  key: 'git.worktreeSupport',
  slot: 'repoState',
  schema: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  title: 'Subagent worktrees',
  description:
    'Allow spawned subagents to run in isolated git worktrees so parallel edits do not conflict.',
  category: 'git',
} as const satisfies SettingRow<boolean>;

// --- Workspace agents ----------------------------------------------------------
// Written and read by the agent list and the settings view's agent catalog,
// which no catalog-driven UI renders.
const WORKSPACE_AGENTS_SETTING = {
  key: WorkspaceStateKey.WORKSPACE_AGENTS,
  slot: 'repoState',
  schema: WorkspaceAgentsSelectionSchema.pipe(
    Schema.withDecodingDefault(Effect.succeed(INHERITED_WORKSPACE_AGENTS)),
  ),
} as const satisfies SettingRow<typeof WorkspaceAgentsSelectionSchema.Type>;

const HIDDEN_CUSTOM_AGENTS_SETTING = {
  key: WorkspaceStateKey.HIDDEN_CUSTOM_AGENTS,
  slot: 'repoState',
  schema: HiddenCustomAgentKeysSchema.pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
} as const satisfies SettingRow<readonly string[]>;

// --- Agent coordination ---------------------------------------------
// Both child-work policy toggles live in `globalState`: they describe how
// *this user* wants child runs handled, not anything about a particular
// checkout.

export const ALLOW_ORCHESTRATOR_KILL_SETTING = {
  key: 'allowOrchestratorKill',
  slot: 'globalState',
  schema: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  title: 'Let a task stop its agents',
  description:
    'Allow a task to stop the agents it started once they are no longer needed.',
  category: 'agents',
} as const satisfies SettingRow<boolean>;

export const DETACH_SUBAGENTS_ON_STOP_SETTING = {
  key: 'detachSubagentsOnStop',
  slot: 'globalState',
  schema: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  title: 'Keep agents running',
  description: "Let a task's agents continue when the task is stopped.",
  category: 'agents',
} as const satisfies SettingRow<boolean>;

/**
 * Every host's runtime honors the row through the `memory` entry of the
 * memory-workflow plugin's `injectedWhen` (`@tools/plugins`).
 */
export const MEMORY_ENABLED_SETTING = {
  key: 'memory.enabled',
  slot: 'globalState',
  schema: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  title: 'Enable memory for chat agents',
  description: 'Remember useful details across chat sessions.',
  category: 'tools',
} as const satisfies SettingRow<boolean>;

/**
 * Code mode's "only" stage: every chat run gets `script`, and the model sees
 * no other tool; the rest are callable from scripts alone. The codemode
 * plugin's `injectedWhen` reads the row to inject `script`; the step reads it
 * to send the model `script` and the run's own tools alone, recorded per tool
 * on its `tools.offered` row.
 */
export const SCRIPT_ONLY_SETTING = {
  key: 'codeMode.scriptOnly',
  slot: 'globalState',
  schema: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  title: 'Script-only tools',
  description:
    'Send chat agents the script tool and their own tools alone: every other tool is called from inside a script. Off by default while the comparison against direct tool calls runs.',
  category: 'agents',
} as const satisfies SettingRow<boolean>;

/** The OpenAI WebSocket transport (experimental). */
export const WEBSOCKET_OPENAI_SETTING = {
  key: 'websocket.openai',
  slot: 'globalState',
  schema: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  title: 'OpenAI WebSocket',
  description:
    'EXPERIMENTAL: use the persistent WebSocket transport for OpenAI Responses requests (lower latency for tool-use loops), and let the ChatGPT-subscription Codex backend attempt WebSocket. Off by default.',
  category: 'model',
} as const satisfies SettingRow<boolean>;

/**
 * No default here: absent means none is configured, and a helper call uses
 * the run's own model. An app names its own (`settingsCatalog`'s
 * `defaults`).
 */
export const HELPER_MODEL_SETTING = {
  key: 'helperModel',
  slot: 'globalState',
  schema: Schema.UndefinedOr(Schema.String.check(Schema.isMinLength(1))),
  title: 'Helper model',
  description:
    "Model used for auxiliary tasks: instruction polishing, merges, and session descriptions. When unset, a run's helper calls use the run's own model.",
  category: 'model',
} as const satisfies SettingRow<string | undefined>;

export const KIMI_CODE_PREFER_SETTING = {
  key: 'kimiCode.prefer',
  slot: 'globalState',
  schema: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  title: 'Kimi Code subscription',
  description:
    'Route dual-backend Kimi models (K3) through the Kimi Code coding endpoint when a Kimi Code API key is set. The two coding-only models always use the key. When off, K3 uses the Moonshot open platform.',
  category: 'model',
} as const satisfies SettingRow<boolean>;

export const GLM_CODING_PLAN_SETTING = {
  key: 'glm.codingPlan',
  slot: 'globalState',
  schema: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  title: 'GLM Coding Plan',
  description:
    'Use a Coding Plan subscription key instead of pay-as-you-go. Routes requests through the coding-specific endpoint with monthly quota limits.',
  category: 'model',
} as const satisfies SettingRow<boolean>;

/**
 * Keep file-oriented tools inside the active working directory unless the
 * user explicitly grants them access to arbitrary filesystem paths.
 */
export const TOOL_PATH_PROTECTION_SETTING = {
  key: 'tools.restrictPathsToWorkingDirectory',
  slot: 'workspaceState',
  schema: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  title: 'Restrict tool paths to the working directory',
  description:
    'Keep file-reading, editing, search, diagnostics, and PDF tools inside the active working directory. Turn this off only when an agent must use arbitrary filesystem paths.',
  category: 'tools',
} as const satisfies SettingRow<boolean>;

// ============================================================================
// The catalog — the harness's rows followed by an app's
// ============================================================================

/** The harness's own rows, in catalog order: config-file-backed, then state-backed. */
const HARNESS_SETTINGS = [
  CHILD_RUN_CONCURRENCY_BUDGET_SETTING,
  GOAL_MAX_COST_SETTING,
  GOAL_STRATEGY_SETTING,
  GOOGLE_INTERACTIONS_SERVER_STATE_SETTING,
  GOOGLE_BACKGROUND_RESPONSES_SETTING,
  OPENAI_FAST_TIER_SETTING,
  MODEL_COMPACTION_THRESHOLD_SETTING,
  MODEL_RETRY_MAX_ATTEMPTS_SETTING,
  CHATGPT_PREFER_SUBSCRIPTION_SETTING,
  CHATGPT_CODEX_CONTEXT_WINDOW_SETTING,
  XAI_PREFER_SUBSCRIPTION_SETTING,
  MAX_IMAGE_DIMENSION_SETTING,
  GIT_COMMITS_TO_SHOW_SETTING,
  SOX_PATH_SETTING,
  DEBUG_MODE_SETTING,
  SAVE_MODEL_IO_SETTING,
  AGENT_SKILLS_ENABLED_SETTING,
  APPROVAL_POLICY_SETTING,
  GIT_MARK_COMMITS_SETTING,
  GIT_AUTHOR_NAME_SETTING,
  GIT_AUTHOR_EMAIL_SETTING,
  GIT_WORKTREE_SUPPORT_SETTING,
  WORKSPACE_AGENTS_SETTING,
  HIDDEN_CUSTOM_AGENTS_SETTING,
  ALLOW_ORCHESTRATOR_KILL_SETTING,
  DETACH_SUBAGENTS_ON_STOP_SETTING,
  MEMORY_ENABLED_SETTING,
  SCRIPT_ONLY_SETTING,
  WEBSOCKET_OPENAI_SETTING,
  ...PROVIDER_ENDPOINT_SETTINGS,
  HELPER_MODEL_SETTING,
  KIMI_CODE_PREFER_SETTING,
  ...PROVIDER_REGION_SETTINGS,
  GLM_CODING_PLAN_SETTING,
  DISABLED_SKILLS_SETTING,
  DISABLED_SKILL_SOURCES_SETTING,
  TOOL_PATH_PROTECTION_SETTING,
] as const satisfies readonly SettingRow[];

/** One settings catalog: its rows and the lookups the stores read from them. */
export interface SettingsCatalog {
  /** The app's prefix on every stored key (`texra`): the config and state
   *  stores write a row's relative key as `<namespace>.<key>`. */
  readonly namespace: string;
  /** Every row, in catalog order. */
  readonly rows: readonly SettingRow[];
  /** Look up any row, config-file-backed or state-backed, by its key. */
  readonly byKey: (key: string) => SettingRow | undefined;
  /** Look up a row by its stored key, as a store lists it. */
  readonly byStoredKey: (storedKey: string) => SettingRow | undefined;
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
 *  stored under `namespace`. A key declared twice is a defect and throws, and
 *  so does a `defaults` key that names no harness row. */
export function settingsCatalog(options: {
  readonly namespace: string;
  readonly rows: readonly SettingRow[];
  /** The app's own defaults for harness rows, by key: the value an absent
   *  key reads as (the helper model, which the harness leaves unset). */
  readonly defaults?: Readonly<Record<string, unknown>>;
}): SettingsCatalog {
  const appDefaults = options.defaults ?? {};
  const unowned = Object.keys(appDefaults).filter(
    (key) => !HARNESS_SETTINGS.some((row) => row.key === key),
  );
  if (unowned.length > 0) {
    throw new Error(`No harness setting has the key ${unowned.join(', ')}.`);
  }
  const harnessRows = HARNESS_SETTINGS.map((row: SettingRow): SettingRow => {
    if (!Object.hasOwn(appDefaults, row.key)) return row;
    // An app default the row's own schema refuses is a defect of the app:
    // it fails here, where the catalog is built, not at the first read. The
    // default stands in for the absent stored value before decoding, so the
    // value checked is the value an absent key decodes from; `undefined`
    // would only mask the row's own default, and is refused.
    if (appDefaults[row.key] === undefined) {
      throw new Error(`The app default for ${row.key} is undefined.`);
    }
    Schema.decodeUnknownSync(row.schema)(appDefaults[row.key]);
    return {
      ...row,
      schema: row.schema.pipe(
        Schema.withDecodingDefault(Effect.succeed(appDefaults[row.key])),
      ),
    };
  });
  const rows = [...harnessRows, ...options.rows];
  const byKey = new Map<string, SettingRow>();
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
      return Predicate.isObjectOrArray(value) ? structuredClone(value) : value;
    },
  };
}
