import { hint, type ModelConfig } from 'llm-zoo';

import type { ModelOptionData } from '@shared/schemas';
import {
  DEFAULT_AGENT_MODEL,
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
 * Curated models every user starts with enabled; the persisted selection is a
 * delta over this list. `llm-zoo` has no "featured" flag to derive it from, so
 * it is literal data — `ModelOptionsBasic.vitest.ts` fails an llm-zoo bump that
 * retires or deprecates an entry, and the entry is replaced here.
 */
export const DEFAULT_MODELS: readonly string[] = [
  // The picker / new-chat default leads. Do not lead with Gemini — GPT is the
  // quality default.
  DEFAULT_AGENT_MODEL,
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
