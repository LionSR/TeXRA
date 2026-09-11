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
 * table is hand-maintained. {@link DEFAULT_MODELS} drops picks that the live
 * registry has retired or deprecated.
 */
export const PREFERRED_DEFAULT_MODELS: readonly string[] = [
  // First entry is the picker / new-chat default (`DEFAULT_AGENT_MODEL`).
  // Do not lead with Gemini — GPT is the quality default.
  'gpt56',
  'gpt56-',
  'gpt56--',
  'sonnet5T',
  'opus5T',
  'fable51',
  'gemini38f',
  'gemini31p',

  'deepseek41T',
  'deepseekproT',
  'kimi26T',
  'kimi3',
  // Current non-retired GLM flagships.
  'glm53',
  'glm53flash',
  // Current non-retired xAI flagship — API key or experimental Grok OAuth.
  'grok45',
  'musespark13',
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
