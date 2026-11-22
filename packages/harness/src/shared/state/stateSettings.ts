// Third-party imports
import { Predicate, Schema } from 'effect';
import {
  decodingDefault,
  ActiveSkillSourceScopeSchema,
  QualifiedSkillNameSchema,
} from '@shared/schemas';

// Local imports - shared constants & state keys
import {
  APPROVAL_POLICY_DEFAULT,
  ApprovalPolicySchema,
} from '@shared/approvalPolicy';
import {
  booleanWithDefault,
  PROVIDER_ENDPOINT_SETTINGS,
  PROVIDER_REGION_SETTINGS,
} from '@shared/state/providerSettings';
import type { ConfigTarget } from '@shared/config/settings';

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
 * (`packages/texra/src/shared/settings/settingSurfaces.ts`).
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

/**
 * One stored key: where it lives and what its stored value decodes to. A
 * key that is not a setting (a stored record, a flag) is one of these beside
 * its owner, read with `Settings.state`; a setting row is one with copy.
 */
export interface StateKey<A = unknown> {
  /** The key, relative to its catalog's namespace (`memory.enabled`), which
   *  the stores add (`<namespace>.memory.enabled`). */
  readonly key: string;
  /** Where the value is stored, the same on every host. */
  readonly slot: SettingStore;
  /**
   * The schema, carrying validation, any bounds, and the decoding default
   * applied when the key is absent: decoding `undefined` yields that
   * default.
   */
  readonly schema: Schema.Codec<A, unknown>;
}

/** One setting, whose schema decodes its stored value to an `A`. */
export interface SettingRow<A = unknown> extends StateKey<A> {
  /** Value to use after warning about an invalid stored setting, when an absent default could grant more access. */
  readonly invalidValue?: A;
  /** Short sentence-case label every settings UI shows for the row. */
  readonly title: string;
  /** Human-readable description, shared across every host that renders it. */
  readonly description: string;
  /** Config-backed target, workspace when omitted; `global`/`local` skip the project file. */
  readonly configTarget?: ConfigTarget;
  /**
   * A `global` row a project file may still switch off: its project value
   * counts unless it is `true`, so a repository can opt out (telemetry) but
   * never opt in. A malformed project value counts too, and fails closed.
   */
  readonly projectMayOptOut?: true;
  /**
   * Display copy for each value of an enum setting, keyed by the value, so
   * the record is total over the schema's values by type. The values
   * themselves are read off the schema, not restated here; a value without
   * a label shows as itself.
   */
  readonly choices?: { readonly [V in A & string]: SettingChoiceCopy };
}

/**
 * How a message points a person to `row`: the title every settings UI shows
 * and the key `/config`, `texra config` and a config file take, so the pointer
 * is right on every host. A message names no settings page: where a row is
 * shown is the app's to decide.
 */
export const settingName = (row: Pick<SettingRow, 'title' | 'key'>): string =>
  `"${row.title}" (\`${row.key}\`)`;

/** How a settings UI shows one value of an enum setting. */
export interface SettingChoiceCopy {
  readonly label?: string;
  readonly description?: string;
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
  schema: decodingDefault(
    Schema.Int.check(
      Schema.isBetween({
        minimum: CHILD_RUN_CONCURRENCY_BUDGET_RANGE.auto,
        maximum: CHILD_RUN_CONCURRENCY_BUDGET_RANGE.max,
      }),
    ),
    CHILD_RUN_CONCURRENCY_BUDGET_RANGE.auto,
  ),
  title: 'Agents at once',
  description:
    'Maximum agents a task can run in parallel (0 uses your CPU count). Extra agents wait for a slot.',
} as const satisfies SettingRow<number>;

/**
 * What a goal's rounds may spend before it pauses instead of starting another
 * round; `0` disables the cap. Read when the goal launches, into its script.
 * Global: a committed project config must not raise or remove the user's cap.
 */
export const GOAL_MAX_COST_SETTING = {
  key: 'goal.maxCostUsd',
  slot: 'config',
  schema: decodingDefault(
    Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })),
    5,
  ),
  configTarget: 'global',
  title: 'Goal spend cap (USD)',
  description:
    'Maximum spend (USD) across rounds before an autonomous goal pauses. Set to 0 for no cap.',
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
  schema: decodingDefault(
    Schema.String.check(Schema.isPattern(/^builtIn:[A-Za-z0-9_-]+$/)),
    'builtIn:goal',
  ),
  configTarget: 'global',
  title: 'Goal strategy',
  description:
    'Built-in script module (`builtIn:<name>`) that controls autonomous goal rounds and stopping.',
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
  schema: booleanWithDefault(true),
  configTarget: 'global',
  title: 'Server-side conversation state',
  description:
    "Keep conversation state on Google's servers so each turn sends only new messages. Turn off to resend the full history each turn.",
} as const satisfies SettingRow<boolean>;

export const OPENAI_FAST_TIER_SETTING = {
  key: 'model.openaiFastTier',
  slot: 'config',
  schema: booleanWithDefault(false),
  configTarget: 'global',
  title: 'Fast mode',
  description:
    "Use OpenAI's fast service tier on supported models (faster responses at a higher per-token price).",
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
  schema: decodingDefault(
    Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
    75,
  ),
  title: 'Compaction threshold',
  description:
    'Summarize earlier messages when a conversation reaches this percentage of the context limit (0 disables).',
} as const satisfies SettingRow<number>;

/** The number of automatic retries after the initial model request. */
export const MODEL_RETRY_MAX_ATTEMPTS_SETTING = {
  key: 'model.retry.maxAttempts',
  slot: 'config',
  schema: decodingDefault(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 })),
    2,
  ),
  title: 'Automatic retries',
  description:
    'Automatic retries after a failed model request (0–5). Interrupted requests retry when resumed.',
} as const satisfies SettingRow<number>;

export const CHATGPT_PREFER_SUBSCRIPTION_SETTING = {
  key: 'chatgptCodex.preferSubscription',
  slot: 'config',
  schema: booleanWithDefault(false),
  title: 'ChatGPT subscription',
  description:
    'Route supported OpenAI models through your signed-in ChatGPT subscription instead of an API key (experimental).',
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
  schema: decodingDefault(
    Schema.NullOr(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 872 })),
    ),
    null,
  ),
  title: 'Subscription input token budget (K tokens)',
  description:
    "Input token budget (in thousands, up to 872) for ChatGPT subscription routing. Leave empty to use each model's default.",
} as const satisfies SettingRow<number | null>;

export const XAI_PREFER_SUBSCRIPTION_SETTING = {
  key: 'xaiGrok.preferSubscription',
  slot: 'config',
  schema: booleanWithDefault(false),
  title: 'Grok subscription',
  description:
    'Route xAI models through your signed-in Grok subscription instead of an API key (experimental).',
} as const satisfies SettingRow<boolean>;

export const MAX_IMAGE_DIMENSION_SETTING = {
  key: 'maxImageDimension',
  slot: 'config',
  schema: decodingDefault(
    Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 10_000 })),
    2000,
  ),
  title: 'Maximum image size (px)',
  description:
    'Resize attached images larger than this dimension (width or height, in pixels).',
} as const satisfies SettingRow<number>;

/**
 * Transcript verbosity, its one meaning: the debug tier of the transcript
 * view and the detail of the payloads it shows. A log surface's own level
 * filter decides what that surface prints, so no producer reads this row to
 * widen or narrow a log; only a view build does.
 */
export const DEBUG_MODE_SETTING = {
  key: 'logger.debugMode',
  slot: 'config',
  schema: booleanWithDefault(false),
  title: 'Verbose transcript',
  description: 'Show debug entries and full tool payloads in task transcripts.',
} as const satisfies SettingRow<boolean>;

export const SAVE_MODEL_IO_SETTING = {
  key: 'debug.saveModelIO',
  slot: 'config',
  schema: booleanWithDefault(false),
  title: 'Save model requests and responses',
  description:
    'Save raw model requests and responses (JSON) and final prompts (XML) for debugging.',
} as const satisfies SettingRow<boolean>;

/** Whether agents receive the skills discovered from every source. */
export const AGENT_SKILLS_ENABLED_SETTING = {
  key: 'skills.enabled',
  slot: 'config',
  schema: booleanWithDefault(false),
  title: 'Enable skills for agents',
  description: 'Include enabled skills in agent prompts (off by default).',
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
  schema: decodingDefault(ApprovalPolicySchema, APPROVAL_POLICY_DEFAULT),
  invalidValue: APPROVAL_POLICY_DEFAULT,
  title: 'Approval policy',
  description:
    'Whether agents ask before running shell commands and editing files.',
  configTarget: 'local',
  choices: {
    never: { label: 'Block' },
    ask: { label: 'Ask' },
    yolo: { label: 'Auto-approve' },
  },
} as const satisfies SettingRow<typeof ApprovalPolicySchema.Type>;

export const DISABLED_SKILLS_SETTING = {
  key: 'skills.disabled',
  slot: 'config',
  schema: decodingDefault(Schema.Array(QualifiedSkillNameSchema), []),
  title: 'Skills',
  description: 'Enable or disable individual skills in this project.',
} as const satisfies SettingRow<readonly string[]>;

export const DISABLED_SKILL_SOURCES_SETTING = {
  key: 'skills.disabledSources',
  slot: 'config',
  schema: decodingDefault(Schema.Array(ActiveSkillSourceScopeSchema), [
    'interop',
  ]),
  title: 'Skill sources',
  description:
    'Enable or disable skill folders in this project. Imported folders (.agents, .claude, .codex, .gemini) start off.',
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
  schema: booleanWithDefault(true),
  title: 'Mark agent commits',
  description:
    'Attribute agent-authored git commits to the agent commit author so they are distinguishable from your own commits.',
} as const satisfies SettingRow<boolean>;

/**
 * The identity agent-authored commits carry while commit marking is on. The
 * harness names none: an app's catalog supplies its own (`settingsCatalog`'s
 * `defaults`), and while neither the person nor the app names one, commits
 * keep git's own identity. `.min(1)` so a blank value is rejected at the
 * write boundary.
 */
export const GIT_AUTHOR_NAME_SETTING = {
  key: 'git.authorName',
  slot: 'repoState',
  schema: Schema.UndefinedOr(Schema.NonEmptyString),
  title: 'Agent commit author',
  description:
    'Author and committer name used for agent-authored commits when commit marking is enabled.',
} as const satisfies SettingRow<string | undefined>;

/** The email beside {@link GIT_AUTHOR_NAME_SETTING}, by the same rule. */
export const GIT_AUTHOR_EMAIL_SETTING = {
  key: 'git.authorEmail',
  slot: 'repoState',
  schema: Schema.UndefinedOr(Schema.NonEmptyString),
  title: 'Agent commit email',
  description:
    'Author and committer email used for agent-authored commits when commit marking is enabled.',
} as const satisfies SettingRow<string | undefined>;

export const GIT_WORKTREE_SUPPORT_SETTING = {
  key: 'git.worktreeSupport',
  slot: 'repoState',
  schema: booleanWithDefault(false),
  title: 'Agent worktrees',
  description:
    'Run parallel agents in isolated git worktrees so edits do not conflict.',
} as const satisfies SettingRow<boolean>;

// --- Agent coordination ---------------------------------------------
// Both child-work policy toggles live in `globalState`: they describe how
// *this user* wants child runs handled, not anything about a particular
// checkout.

export const ALLOW_ORCHESTRATOR_KILL_SETTING = {
  key: 'allowOrchestratorKill',
  slot: 'globalState',
  schema: booleanWithDefault(true),
  title: 'Let a task stop its agents',
  description:
    'Allow a task to stop the agents it started once they are no longer needed.',
} as const satisfies SettingRow<boolean>;

/**
 * Every host's runtime honors the row through the `memory` entry of the
 * memory-workflow plugin's `injectedWhen` (`@tools/plugins`).
 */
export const MEMORY_ENABLED_SETTING = {
  key: 'memory.enabled',
  slot: 'globalState',
  schema: booleanWithDefault(true),
  title: 'Enable memory',
  description: 'Remember useful details across tasks.',
} as const satisfies SettingRow<boolean>;

/** The OpenAI WebSocket transport (experimental). */
export const WEBSOCKET_OPENAI_SETTING = {
  key: 'websocket.openai',
  slot: 'globalState',
  schema: booleanWithDefault(false),
  title: 'OpenAI WebSocket',
  description:
    'Experimental: send OpenAI API-key requests over WebSocket for lower latency (off by default).',
} as const satisfies SettingRow<boolean>;

/**
 * No default here: absent means none is configured, and a helper call uses
 * the run's own model. An app names its own (`settingsCatalog`'s
 * `defaults`).
 */
export const HELPER_MODEL_SETTING = {
  key: 'helperModel',
  slot: 'globalState',
  schema: Schema.UndefinedOr(Schema.NonEmptyString),
  title: 'Helper model',
  description:
    "Model for quick helper steps like task titles and merges. Leave empty to use the task's own model.",
} as const satisfies SettingRow<string | undefined>;

export const KIMI_CODE_PREFER_SETTING = {
  key: 'kimiCode.prefer',
  slot: 'globalState',
  schema: booleanWithDefault(false),
  title: 'Kimi Code subscription',
  description:
    'Route dual-backend Kimi models (K3) through Kimi Code when a Kimi Code API key is set.',
} as const satisfies SettingRow<boolean>;

export const GLM_CODING_PLAN_SETTING = {
  key: 'glm.codingPlan',
  slot: 'globalState',
  schema: booleanWithDefault(false),
  title: 'GLM Coding Plan',
  description:
    'Use your GLM API key with GLM Coding Plan quota tracking (ignored with a custom endpoint).',
} as const satisfies SettingRow<boolean>;

/**
 * Keep file-oriented tools inside the active working directory unless the
 * user explicitly grants them access to arbitrary filesystem paths.
 */
export const TOOL_PATH_PROTECTION_SETTING = {
  key: 'tools.restrictPathsToWorkingDirectory',
  slot: 'workspaceState',
  schema: booleanWithDefault(true),
  title: 'Restrict tools to project folder',
  description:
    'Keep file read/edit, search, diagnostics, and PDF tools inside the current project folder. Turn off only if an agent needs outside files.',
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
  OPENAI_FAST_TIER_SETTING,
  MODEL_COMPACTION_THRESHOLD_SETTING,
  MODEL_RETRY_MAX_ATTEMPTS_SETTING,
  CHATGPT_PREFER_SUBSCRIPTION_SETTING,
  CHATGPT_CODEX_CONTEXT_WINDOW_SETTING,
  XAI_PREFER_SUBSCRIPTION_SETTING,
  MAX_IMAGE_DIMENSION_SETTING,
  DEBUG_MODE_SETTING,
  SAVE_MODEL_IO_SETTING,
  AGENT_SKILLS_ENABLED_SETTING,
  APPROVAL_POLICY_SETTING,
  GIT_MARK_COMMITS_SETTING,
  GIT_AUTHOR_NAME_SETTING,
  GIT_AUTHOR_EMAIL_SETTING,
  GIT_WORKTREE_SUPPORT_SETTING,
  ALLOW_ORCHESTRATOR_KILL_SETTING,
  MEMORY_ENABLED_SETTING,
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

/** The key of each of the harness's rows: what an app's table of where it
 *  shows them is total over. */
export type HarnessRowKey = (typeof HARNESS_SETTINGS)[number]['key'];

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
   * A fresh copy of what the row under `key` reads as while it is absent (its
   * schema's default, or the app's), or `undefined` for a key no row owns.
   * Parsed defaults are memoized because this is on the read path of every
   * absent setting; object values are cloned so a caller cannot mutate the
   * catalog's own default.
   */
  readonly defaultOf: (key: string) => unknown;
  /** The models every user starts with enabled, in picker order; a person's
   *  selection is stored as a change over this list. The app's choice over
   *  the llm catalog: the harness curates none. */
  readonly curatedModels: readonly string[];
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
  /** {@link SettingsCatalog.curatedModels}; none when absent. */
  readonly curatedModels?: readonly string[];
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
      schema: decodingDefault(row.schema, appDefaults[row.key]),
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
    curatedModels: Object.freeze([...(options.curatedModels ?? [])]),
    rows,
    byKey: (key) => byKey.get(key),
    byStoredKey: (storedKey) =>
      storedKey.startsWith(`${options.namespace}.`)
        ? byKey.get(storedKey.slice(options.namespace.length + 1))
        : undefined,
    defaultOf: (key) => {
      const entry = byKey.get(key);
      if (entry === undefined) return undefined;
      if (!defaults.has(key)) {
        defaults.set(key, Schema.decodeUnknownSync(entry.schema)(undefined));
      }
      const value = defaults.get(key);
      return Predicate.isObjectOrArray(value) ? structuredClone(value) : value;
    },
  };
}
