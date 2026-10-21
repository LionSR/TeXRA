/**
 * Config keys, bounded schemas, and defaults shared by more than one reader.
 *
 * The settings themselves — schema, default, copy, honoring hosts, rendering
 * surfaces — live as rows on the one catalog in `stateSettings.ts`. This module
 * holds only what a runtime reader needs to name a key or reuse a bounded
 * schema without importing the catalog.
 */

export const TOOL_EDIT_APPROVAL_CONFIG_KEY =
  'texra.toolUse.requireEditApproval';

export const BASH_APPROVAL_CONFIG_KEY = 'texra.toolUse.requireBashApproval';

/** Canonical config key for the per-session child-run concurrency budget. */
export const CHILD_RUN_CONCURRENCY_BUDGET_CONFIG_KEY =
  'texra.childRunConcurrencyBudget';

/**
 * Canonical config key for `texra.logger.debugMode`, whose one meaning is
 * transcript verbosity: the debug tier of the transcript fold and the detail
 * of the payloads it shows. A log surface's own level filter decides what
 * that surface prints, so no producer reads this key to widen or narrow a
 * log — only a fold's view build does.
 */
export const DEBUG_MODE_KEY = 'texra.logger.debugMode';

/**
 * Bounds, default, and copy for `model.retry.maxAttempts`. The value is the
 * number of automatic retries after the initial model request. Shared by the
 * catalog row's schema and its copy so the two cannot disagree about the range.
 */
export const MODEL_RETRY_MAX_ATTEMPTS_SETTING = Object.freeze({
  configKey: 'texra.model.retry.maxAttempts',
  defaultValue: 2,
  min: 0,
  max: 5,
  description:
    'Additional automatic retries after the initial model request (0–5). A resumed request keeps the retries it already used.',
} as const);

/**
 * Bounds, default, and copy for `model.compactionThresholdPercent`. The value
 * is the share of the model's context window that triggers automatic
 * compaction, and `0` disables it. Shared by the catalog row and the runtime
 * reader so the two cannot disagree about the range.
 */
export const MODEL_COMPACTION_THRESHOLD_SETTING = Object.freeze({
  configKey: 'texra.model.compactionThresholdPercent',
  defaultValue: 75,
  min: 0,
  max: 100,
  description:
    "When the conversation reaches this percentage of the model's context limit, earlier messages are summarized automatically to free up space. Lower values trigger summarization sooner. Set to 0 to disable.",
} as const);

/**
 * Bounds and copy for the ChatGPT-subscription input budget; unset, each
 * model takes the window the Codex backend grants it.
 *
 * The stored unit is **thousands of tokens**, and the key says so. Every
 * budget in play is a round multiple of 1000 (272K, 400K, 872K), so a raw
 * token count is three zeros nobody wants to type and an off-by-1000 typo
 * lands inside the valid range instead of being rejected: `872` entered for
 * 872,000 is a legal 872-token budget that puts every request over the limit,
 * and the failure then names a number the user never meant to set.
 */
export const CHATGPT_CODEX_CONTEXT_WINDOW_SETTING = Object.freeze({
  configKey: 'texra.chatgptCodex.contextWindowK',
  /** Tokens per stored unit; the sole reader multiplies by this. */
  tokensPerUnit: 1_000,
  min: 1,
  max: 872,
  unitLabel: 'K tokens',
  description:
    "Input token budget for ChatGPT-subscription (Codex) routing, in thousands of tokens, mirroring Codex CLI's model_context_window. Unset, each model takes the window the Codex backend grants it (500 for GPT-6.1 Sol, 272 for the others); a value overrides it for every model, up to 872 (872,000 tokens). Automatic compaction may run earlier according to the separate compaction threshold. The model's output budget is added when displaying the total context window. The OpenAI backend enforces the real per-account limit — values above what your subscription allows fail and trigger compaction recovery.",
} as const);

/**
 * Bounds, default, and copy for `childRunConcurrencyBudget`. The value caps the
 * number of live native child model conversations one session runs at once.
 * Shared by the catalog row and the runtime reader so the two cannot disagree
 * about the range.
 */
export const CHILD_RUN_CONCURRENCY_BUDGET_SETTING = Object.freeze({
  /** `0` sizes the budget to this machine's core count at runtime — the
   *  same "special value inside the range" shape as the compaction
   *  threshold's `0 = disable`, so the number widget needs no second mode. */
  auto: 0,
  defaultValue: 0,
  min: 0,
  max: 100,
  description:
    "Maximum number of agents one task may run at once in the background; a script's agent() calls also run at most this many at once. 0 (the default) sizes it to this machine's CPU count. Agents beyond the budget wait for a slot to free.",
} as const);

/**
 * What an interactive host window does at open with the tasks a closed or
 * crashed process left interrupted:
 * `ask` lists them, `auto` continues them. Headless runs and the SDK do
 * neither, whatever this says.
 */
export const RESUME_ON_OPEN_SETTING = Object.freeze({
  configKey: 'texra.resumeOnOpen',
  values: ['ask', 'auto'],
  defaultValue: 'ask',
  description:
    'On opening, when tasks stopped before they finished: list them so you can choose, or continue them all.',
} as const);

export type ResumeOnOpen = (typeof RESUME_ON_OPEN_SETTING.values)[number];

/**
 * Bounds, default, and copy for `goal.maxCostUsd`: the run tree's total spend
 * at which an active goal pauses instead of opening its next turn, and `0`
 * disables the cap. Read at each idle, so it needs no field on the goal's own
 * row. Shared by the catalog row and the goal continuation so the two cannot
 * disagree about the range.
 */
export const GOAL_MAX_COST_SETTING = Object.freeze({
  configKey: 'texra.goal.maxCostUsd',
  defaultValue: 5,
  min: 0,
  max: 10_000,
  description:
    'Spend in US dollars, across the run and its subagents, at which an autonomous goal pauses instead of starting another turn. Raise it to let the goal continue. Set to 0 to remove the cap (not recommended with auto-approve on your own API key).',
} as const);
