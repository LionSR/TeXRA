// Third-party imports
import { z } from 'zod';

/**
 * Config keys, bounded schemas, and defaults shared by more than one reader.
 *
 * The settings themselves — schema, default, copy, honoring hosts, rendering
 * surfaces — live as rows on the one catalog in `stateSettings.ts`. This module
 * holds only what a runtime reader needs to name a key or reuse a bounded
 * schema without importing the catalog.
 */

export const LATEXDIFF_TEMP_FILE_LOCATIONS = [
  'sameDirectory',
  'workspaceTemp',
] as const;

export const TOOL_EDIT_APPROVAL_CONFIG_KEY =
  'texra.toolUse.requireEditApproval';

/** Canonical config key for the per-session child-run concurrency budget. */
export const CHILD_RUN_CONCURRENCY_BUDGET_CONFIG_KEY =
  'texra.childRunConcurrencyBudget';

/** Canonical config key for the usage-telemetry opt-in. */
export const TELEMETRY_ENABLED_KEY = 'texra.telemetry.enabled';

/**
 * Telemetry is on unless a scope opts out. Shared by the catalog row and by
 * `UsageLogService`, which resolves both scopes itself rather than through the
 * merged config read.
 */
export const TELEMETRY_ENABLED_DEFAULT = true;

/**
 * Bounds, default, and copy for `model.retry.maxAttempts`. The value is the
 * number of automatic retries after the initial model request. Shared by
 * {@link ModelRetryMaxAttemptsSchema} and the settings-view reliability row so
 * the schema and the UI cannot disagree about the range.
 */
export const MODEL_RETRY_MAX_ATTEMPTS_SETTING = Object.freeze({
  configKey: 'texra.model.retry.maxAttempts',
  defaultValue: 2,
  min: 0,
  max: 5,
  description:
    'Additional automatic retries after the initial model request (0–5). Long-running background requests retain at least two recovery retries.',
} as const);

/**
 * Bounds, default, and copy for `model.compactionThresholdPercent`. The value
 * is the share of the model's context window that triggers automatic
 * compaction, and `0` disables it. Shared by
 * {@link ModelCompactionThresholdPercentSchema}, the runtime reader, and the
 * settings-view reliability row so the schema, runtime, and UI cannot disagree
 * about the range.
 */
export const MODEL_COMPACTION_THRESHOLD_SETTING = Object.freeze({
  configKey: 'texra.model.compactionThresholdPercent',
  defaultValue: 75,
  min: 0,
  max: 100,
  description:
    "When the conversation reaches this percentage of the model's context limit, TeXRA automatically summarizes earlier messages to free up space. Lower values trigger summarization sooner. Set to 0 to disable.",
} as const);

export const CHATGPT_CODEX_CONTEXT_WINDOW_SETTING = Object.freeze({
  configKey: 'texra.chatgptCodex.contextWindow',
  defaultValue: 272_000,
  min: 1,
  max: 872_000,
  description:
    "Input token budget for ChatGPT-subscription (Codex) routing, mirroring Codex CLI's model_context_window. The default 272,000 matches the Codex default; GPT-5.6 models accept up to 872,000. TeXRA adds the model's output budget when displaying the total context window. The OpenAI backend enforces the real per-account limit — values above what your subscription allows fail and trigger compaction recovery.",
} as const);

/**
 * Bounds, default, and copy for `childRunConcurrencyBudget`. The value caps the
 * number of live native child model conversations one session runs at once.
 * Shared by {@link ChildRunConcurrencyBudgetSchema}, the runtime reader, and the
 * settings-view Multi-Agent tab so the schema, runtime, and UI cannot disagree
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
    "Maximum number of detached child runs one session may run at once; a workflow script also runs this many agent() calls concurrently (in-band, not counted against the session budget). 0 (the default) sizes it to this machine's CPU count. Detached subagents beyond the budget wait for a slot to free.",
} as const);

export const ModelRetryMaxAttemptsSchema = z
  .int()
  .min(MODEL_RETRY_MAX_ATTEMPTS_SETTING.min)
  .max(MODEL_RETRY_MAX_ATTEMPTS_SETTING.max)
  .prefault(MODEL_RETRY_MAX_ATTEMPTS_SETTING.defaultValue);

export const ModelCompactionThresholdPercentSchema = z
  .number()
  .min(MODEL_COMPACTION_THRESHOLD_SETTING.min)
  .max(MODEL_COMPACTION_THRESHOLD_SETTING.max)
  .prefault(MODEL_COMPACTION_THRESHOLD_SETTING.defaultValue);

export const ChatgptCodexContextWindowSchema = z
  .int()
  .min(CHATGPT_CODEX_CONTEXT_WINDOW_SETTING.min)
  .max(CHATGPT_CODEX_CONTEXT_WINDOW_SETTING.max)
  .prefault(CHATGPT_CODEX_CONTEXT_WINDOW_SETTING.defaultValue);

export const ChildRunConcurrencyBudgetSchema = z
  .int()
  .min(CHILD_RUN_CONCURRENCY_BUDGET_SETTING.min)
  .max(CHILD_RUN_CONCURRENCY_BUDGET_SETTING.max)
  .prefault(CHILD_RUN_CONCURRENCY_BUDGET_SETTING.defaultValue);
