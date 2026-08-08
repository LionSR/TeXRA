import { hint, type ModelConfig } from 'llm-zoo';

import type { ModelOptionData } from '@shared/schemas';
import {
  EXPENSIVE_MODEL_HINT,
  FAST_FIRST_RESPONSE_HINT,
  isExpensiveModel,
  isFastFirstResponseModel,
} from '@shared/constants/providers';
import { getRuntimeModelConfig } from './runtimeModelRegistry';
import { resolveModelSource } from './openRouterRouting';

/** Return whether the registry marks a model as deprecated. */
export function isDeprecatedModel(model: string): boolean {
  return getRuntimeModelConfig(model)?.deprecated ?? false;
}

/** Return whether the registry marks a model as no longer served. */
export function isRetiredModel(model: string): boolean {
  return getRuntimeModelConfig(model)?.retired ?? false;
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
 * retired or deprecated. {@link MODEL_LIST_VERSION} hashes this table paired
 * with each pick's *live status* -- not the resolved post-filter set -- so
 * either this table changing, or a pick's status quietly transitioning
 * underneath it (active to deprecated, deprecated to retired, or back),
 * changes the reconciliation trigger automatically. Hashing status alongside
 * id matters specifically for the deprecated-to-retired case: a pick already
 * excluded from the resolved set for being deprecated stays excluded once
 * it's retired too, so hashing only the resolved set would never notice that
 * transition -- yet `reconcileEnabledModels`'s unconditional retired-model
 * sweep needs exactly that trigger to strip the now-unservable model from
 * existing users. No maintainer has to remember to hand-bump a version
 * constant either way.
 */
export const PREFERRED_DEFAULT_MODELS: readonly string[] = [
  'gemini36f',
  'gemini31p',
  'sonnet5T',
  'opus5T',
  'fable5',
  'gpt56',
  'gpt56-',
  'gpt56--',
  'deepseekT',
  'deepseekproT',
  'kimi26T',
  'kimi3',
  // Current non-retired GLM flagship.
  'glm52',
  // Current non-retired xAI flagship — API key or experimental Grok OAuth.
  'grok45',
];

/**
 * Resolve a preferred model list against the live registry, dropping any pick
 * the registry marks retired or deprecated -- matching the stricter filter
 * `reconcileEnabledModels` (`modelListRefresh.ts`) already applies before
 * granting a default to an *existing* user, so a first-time user (or any
 * direct `DEFAULT_MODELS` consumer, e.g. `SettingsModelSelectionController`)
 * can't be handed a stale default an existing user would never receive.
 * Exported (separately from {@link DEFAULT_MODELS}) so tests can exercise the
 * resolution mechanism itself against known-retired/deprecated registry
 * entries, without depending on {@link PREFERRED_DEFAULT_MODELS} happening to
 * contain one today.
 */
export function resolveDefaultModels(preferred: readonly string[]): string[] {
  return preferred.filter(
    (model) => !isRetiredModel(model) && !isDeprecatedModel(model),
  );
}

/**
 * Models that should be present in every user's model list, resolved against
 * the live registry: a preferred pick the registry now marks retired or
 * deprecated is dropped rather than dangling in the default list with no way
 * back out.
 */
export const DEFAULT_MODELS: readonly string[] = resolveDefaultModels(
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

/**
 * Deterministic 32-bit FNV-1a hash of `input`, as a non-negative integer.
 * Operates on UTF-16 code units (`charCodeAt`), not raw bytes -- byte-
 * equivalent to canonical FNV-1a for the ASCII-only inputs this module hashes
 * (model ids), but not a general byte-level implementation.
 */
function fnv1aHash(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Live registry status of a model. Distinguishes "deprecated" (still
 * servable, discouraged) from "retired" (hard unavailable) so {@link
 * computeModelListVersion} can detect a transition between them even though
 * {@link resolveDefaultModels} filters both out of the resolved set the same
 * way.
 */
type ModelStatus = 'active' | 'deprecated' | 'retired';

function modelStatus(model: string): ModelStatus {
  if (isRetiredModel(model)) return 'retired';
  if (isDeprecatedModel(model)) return 'deprecated';
  return 'active';
}

/**
 * Compute the reconciliation trigger for a preferred-model list: a hash of
 * each pick's id *and* live registry status, sorted so only membership (not
 * order) affects the result. Hashing status alongside id -- rather than
 * hashing only the resolved (post-filter) set -- matters because two picks
 * that both filter out of that set, e.g. one deprecated and one retired,
 * must still produce different hashes: a deprecated pick transitioning to
 * retired needs to change the hash so `reconcileEnabledModels` re-runs and
 * its unconditional retired-model sweep can strip the now-unservable model
 * from existing users. Exported so tests can confirm the trigger actually
 * changes when the registry-derived status does, rather than only asserting
 * today's value.
 */
export function computeModelListVersion(preferred: readonly string[]): number {
  const entries = preferred
    .toSorted()
    .map((model) => `${model}:${modelStatus(model)}`);
  return MODEL_LIST_HASH_BASE + fnv1aHash(entries.join(','));
}

/**
 * Reconciliation trigger for the persisted enabled-models list
 * (`modelListRefresh.ts`). Derived from a hash of {@link
 * PREFERRED_DEFAULT_MODELS} paired with each pick's live registry status,
 * instead of a hand-bumped integer, so a registry change that alters what
 * resolves -- a curated pick's status transitioning (including between two
 * statuses that both drop it from {@link DEFAULT_MODELS}, like deprecated to
 * retired), or a maintainer editing {@link PREFERRED_DEFAULT_MODELS} -- is
 * detected automatically on the next launch rather than relying on someone
 * remembering to bump this value.
 */
export const MODEL_LIST_VERSION: number = computeModelListVersion(
  PREFERRED_DEFAULT_MODELS,
);

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
    provider: resolveModelSource(config) ?? config.provider,
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
    const config = getRuntimeModelConfig(model);
    if (!config) return { value: model, label: model };
    return buildBaseModelOption(model, config);
  });
}
