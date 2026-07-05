import { MODEL_CONFIGS, hint, type ModelConfig } from 'llm-zoo';

import type { ModelOptionData } from '@shared/schemas';
import {
  EXPENSIVE_MODEL_HINT,
  isExpensiveModel,
} from '@shared/constants/expensiveModels';
import {
  FAST_FIRST_RESPONSE_HINT,
  isFastFirstResponseModel,
} from '@shared/constants/fastModels';

/** Return whether the registry marks a model as deprecated. */
export function isDeprecatedModel(model: string): boolean {
  return MODEL_CONFIGS[model]?.deprecated ?? false;
}

/** Return whether the registry marks a model as no longer served. */
export function isRetiredModel(model: string): boolean {
  return MODEL_CONFIGS[model]?.retired ?? false;
}

/**
 * Curated pick of models that should be present in every user's model list --
 * a *preference*, not the source of truth for whether each pick is still
 * servable. `llm-zoo`'s `ModelConfig` has no "featured"/"default" capability
 * flag to derive this set from directly, so -- the same way
 * `setupModelDefaults.ts` curates one setup-probe model per provider -- this
 * table is hand-maintained. What IS derived from the registry, so this table
 * going stale can never silently ship a dead default, is {@link
 * DEFAULT_MODELS} below: it drops any pick the live registry has since
 * retired. {@link MODEL_LIST_VERSION} then hashes that resolved (post-filter)
 * set, so either this table changing or a pick quietly retiring underneath it
 * changes the reconciliation trigger automatically -- no maintainer has to
 * remember to hand-bump a version constant.
 */
const PREFERRED_DEFAULT_MODELS: readonly string[] = [
  'gemini35f',
  'gemini31p',
  'sonnet46T',
  'opus48T',
  'fable5',
  'gpt55',
  'gpt54',
  'deepseekproT',
  'kimi26T',
];

/**
 * Resolve a preferred model list against the live registry, dropping any pick
 * the registry marks retired. Exported (separately from {@link
 * DEFAULT_MODELS}) so tests can exercise the resolution mechanism itself
 * against a known-retired registry entry, without depending on {@link
 * PREFERRED_DEFAULT_MODELS} happening to contain one today.
 */
export function resolveDefaultModels(preferred: readonly string[]): string[] {
  return preferred.filter((model) => !isRetiredModel(model));
}

/**
 * Models that should be present in every user's model list, resolved against
 * the live registry: a preferred pick the registry now marks retired is
 * dropped rather than dangling in the default list with no way back out.
 */
export const DEFAULT_MODELS: string[] = resolveDefaultModels(
  PREFERRED_DEFAULT_MODELS,
);

/**
 * Baseline added to the {@link MODEL_LIST_VERSION} hash so it can never
 * collide with the hand-bumped integers (1-21) this file used before it
 * switched to a registry-derived trigger -- `reconcileEnabledModels`'s
 * one-time migration gates read a user's previously *persisted* version
 * number, which for every existing install is still one of those small
 * integers, so the new value must land clear of that range.
 */
const MODEL_LIST_HASH_BASE = 1000;

/** Deterministic 32-bit FNV-1a hash of `input`, as a non-negative integer. */
function fnv1aHash(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Compute the reconciliation trigger for a resolved default-model set: a hash
 * of `models` sorted so only membership, not order, affects the result.
 * Exported so tests can confirm the trigger actually changes when the
 * registry-derived set does, rather than only asserting today's value.
 */
export function computeModelListVersion(models: readonly string[]): number {
  return MODEL_LIST_HASH_BASE + fnv1aHash([...models].sort().join(','));
}

/**
 * Reconciliation trigger for the persisted enabled-models list
 * (`modelListRefresh.ts`). Derived from a hash of the resolved {@link
 * DEFAULT_MODELS} set instead of a hand-bumped integer, so a registry change
 * that alters what resolves (a curated pick retiring and dropping out, or a
 * maintainer editing {@link PREFERRED_DEFAULT_MODELS}) is detected
 * automatically on the next launch rather than relying on someone
 * remembering to bump this value.
 */
export const MODEL_LIST_VERSION: number =
  computeModelListVersion(DEFAULT_MODELS);

const MILLION = 1_000_000;
const THOUSAND = 1_000;

/** Format context window number for display. */
function formatContext(context: number | undefined): string | undefined {
  if (context === undefined) return undefined;
  if (context >= MILLION) return `${(context / MILLION).toFixed(1)}M`;
  if (context >= THOUSAND) return `${Math.round(context / THOUSAND)}K`;
  return context.toString();
}

/** Format cost values for display. */
function formatCost(
  inputPrice: number | undefined,
  outputPrice: number | undefined,
): string | undefined {
  if (inputPrice === undefined || outputPrice === undefined) return undefined;
  return `$${inputPrice.toFixed(3)}/$${outputPrice.toFixed(3)}`;
}

function prefixHint(prefix: string, base: string): string {
  return base ? `${prefix} | ${base}` : prefix;
}

/** Build the model tooltip string from static model metadata. */
function buildModelHint(config: ModelConfig): string {
  const base = hint(config);
  if (isExpensiveModel(config.provider, config.name)) {
    return prefixHint(EXPENSIVE_MODEL_HINT, base);
  }
  if (isFastFirstResponseModel(config.inputPrice)) {
    return prefixHint(FAST_FIRST_RESPONSE_HINT, base);
  }
  return base;
}

/** Project a model config to the base option fields shared across views. */
export function buildBaseModelOption(
  model: string,
  config: ModelConfig,
  hintConfig: ModelConfig = config,
): ModelOptionData {
  return {
    value: model,
    label: config.label,
    provider: config.provider,
    context: formatContext(config.contextWindow),
    cost: formatCost(config.inputPrice, config.outputPrice),
    hint: buildModelHint(hintConfig),
  };
}

/** Build model options from static config without provider availability checks. */
export function buildBasicModelOptionsData(
  visibleModels: readonly string[],
): ModelOptionData[] {
  return visibleModels.map((model) => {
    const config = MODEL_CONFIGS[model];
    if (!config) return { value: model, label: model };
    return buildBaseModelOption(model, config);
  });
}
