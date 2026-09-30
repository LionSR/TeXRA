import { hint, type ModelConfig } from 'llm-zoo';

import type { ModelOptionData } from '@shared/schemas';
import {
  DEFAULT_AGENT_MODEL,
  EXPENSIVE_MODEL_HINT,
  FAST_FIRST_RESPONSE_HINT,
  isExpensiveModel,
  isFastFirstResponseModel,
} from '@shared/constants/providers';
import { modelConfig } from '@shared/model/modelSelection';
import { formatCostUsd } from '@utils/text/stringUtils';
import { resolveModelSource } from './openRouterRouting';

/** Return whether the registry marks a model as deprecated. */
export function isDeprecatedModel(model: string): boolean {
  return modelConfig(model)?.deprecated ?? false;
}

/** Return whether the registry marks a model as no longer served. */
export function isRetiredModel(model: string): boolean {
  return modelConfig(model)?.retired ?? false;
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
  'openai/gpt-5.6-terra',
  'openai/gpt-6-luna',
  'anthropic/claude-sonnet-5-5',
  'anthropic/claude-opus-5-5',
  'anthropic/claude-fable-5-1',
  'google/gemini-3.8-flash',
  'google/gemini-3.1-pro-preview',

  'deepseek/deepseek-flash',
  'deepseek/deepseek-v4-pro',
  'moonshot/kimi-k3',
  // Current non-retired GLM flagships.
  'glm/glm-5.3',
  // Current non-retired xAI flagship — API key or experimental Grok OAuth.
  'xai/grok-4.7',
  'meta/muse-spark-1.3',
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
  return `${formatCostUsd(inputPrice)}/${formatCostUsd(outputPrice)}`;
}

function prefixHint(prefix: string, base: string): string {
  return base ? `${prefix} | ${base}` : prefix;
}

/** Build the model tooltip string from static model metadata. */
function buildModelHint(config: ModelConfig): string {
  const base = hint(config);
  if (isExpensiveModel(config.outputPrice)) {
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
  source: string = resolveModelSource(config),
): ModelOptionData {
  return {
    value: model,
    label: config.label,
    provider: source,
    context: formatContext(config.contextWindow),
    cost: formatCost(config.inputPrice, config.outputPrice),
    hint: buildModelHint(hintConfig),
  };
}
