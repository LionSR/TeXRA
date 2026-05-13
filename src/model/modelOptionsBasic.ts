import { MODEL_CONFIGS, hint, type ModelConfig } from 'llm-zoo';

import { platform } from '@platform/platform';
import { GlobalStateKey } from '@common/state/stateKeys';
import type { ModelOptionData } from '@shared/schemas';
import {
  EXPENSIVE_MODEL_HINT,
  isExpensiveModel,
} from '@shared/constants/expensiveModels';
import {
  FAST_FIRST_RESPONSE_HINT,
  isFastFirstResponseModel,
} from '@shared/constants/fastModels';

/** Models that should be present in every user's model list. */
export const DEFAULT_MODELS = [
  'gemini31p',
  'sonnet46T',
  'opus47T',
  'gpt55',
  'gpt54',
  'deepseekT',
  'deepseekproT',
  'kimi26T',
];

/** Increment when the persisted model list needs reconciliation. */
export const MODEL_LIST_VERSION = 15;

const MILLION = 1_000_000;
const THOUSAND = 1_000;

/** Get the list of visible models from extension global state. */
export function getVisibleModels(): string[] {
  return platform().globalState.get<string[]>(
    GlobalStateKey.ENABLED_MODELS,
    DEFAULT_MODELS,
  );
}

/** Resolve a model to a valid visible model (fallback to first visible). */
export function resolveVisibleModel(model: string): string {
  const visibleModels = getVisibleModels();
  if (visibleModels.length === 0) return model;
  if (visibleModels.includes(model)) return model;
  return visibleModels[0];
}

/** Return whether the registry marks a model as deprecated. */
export function isDeprecatedModel(model: string): boolean {
  return MODEL_CONFIGS[model]?.deprecated ?? false;
}

/** Format context window number for display. */
export function formatContext(context: number | undefined): string | undefined {
  if (context === undefined) return undefined;
  if (context >= MILLION) return `${(context / MILLION).toFixed(1)}M`;
  if (context >= THOUSAND) return `${Math.round(context / THOUSAND)}K`;
  return context.toString();
}

/** Format cost values for display. */
export function formatCost(
  inputPrice: number | undefined,
  outputPrice: number | undefined,
): string | undefined {
  if (inputPrice === undefined || outputPrice === undefined) return undefined;
  return `$${inputPrice.toFixed(3)}/$${outputPrice.toFixed(3)}`;
}

const prefixHint = (prefix: string, base: string): string =>
  base ? `${prefix} | ${base}` : prefix;

/** Build the model tooltip string from static model metadata. */
export function buildModelHint(config: ModelConfig): string {
  const base = hint(config);
  if (isExpensiveModel(config.provider, config.name))
    return prefixHint(EXPENSIVE_MODEL_HINT, base);
  if (isFastFirstResponseModel(config.inputPrice))
    return prefixHint(FAST_FIRST_RESPONSE_HINT, base);
  return base;
}

/** Build model options from static config without provider availability checks. */
export function buildBasicModelOptionsData(
  visibleModels: readonly string[] = getVisibleModels(),
): ModelOptionData[] {
  return visibleModels.map((model) => {
    const config = MODEL_CONFIGS[model];
    if (!config) return { value: model, label: model };
    return {
      value: model,
      label: config.label,
      provider: config.provider,
      context: formatContext(config.contextWindow),
      cost: formatCost(config.inputPrice, config.outputPrice),
      hint: buildModelHint(config),
    };
  });
}
