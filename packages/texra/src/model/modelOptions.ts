/**
 * The model picker's rows: each model's verdict (`modelVerdictsFrom`, the
 * harness's), worded for display — label, source, context window, prices,
 * tooltip, reasoning column and route badge. Pure.
 */
import { hint, type ModelConfig, type ReasoningEffort } from 'llm-zoo';

import {
  defaultReasoningLevel,
  isKimiCodeExclusiveModel,
  isKimiSubscriptionEligible,
  providerDisplayName,
} from '@texra-ai/llm';
import {
  modelVerdictsFrom,
  type ModelAvailabilityInputs,
  type ModelVerdict,
} from '@model/computeModelOptions';
import { supportsReasoningLevel } from '@model/reasoningLevel';
import type { ModelOptionData } from '@shared/schemas';
import {
  EXPENSIVE_MODEL_HINT,
  FAST_FIRST_RESPONSE_HINT,
  isExpensiveModel,
  isFastFirstResponseModel,
  REASONING_LEVEL_LABELS,
} from '@texra/shared/model/modelPicker';

const MILLION = 1_000_000;
const THOUSAND = 1_000;

/** Format a context window for display. */
function formatContext(context: number | undefined): string | undefined {
  if (context === undefined) return undefined;
  if (context >= MILLION) return `${(context / MILLION).toFixed(1)}M`;
  if (context >= THOUSAND) return `${Math.round(context / THOUSAND)}K`;
  return context.toString();
}

/** Format per-million input and output prices for display. */
function formatCost(
  inputPrice: number | undefined,
  outputPrice: number | undefined,
): string | undefined {
  if (inputPrice === undefined || outputPrice === undefined) return undefined;
  return `$${inputPrice.toFixed(3)}/$${outputPrice.toFixed(3)}`;
}

/** The model tooltip: the registry's hint behind a pricing hint, if any. */
function modelHint(config: ModelConfig): string {
  const base = hint(config);
  let prefix: string | undefined;
  if (isExpensiveModel(config.outputPrice)) prefix = EXPENSIVE_MODEL_HINT;
  else if (isFastFirstResponseModel(config.inputPrice))
    prefix = FAST_FIRST_RESPONSE_HINT;
  if (prefix === undefined) return base;
  return base ? `${prefix} | ${base}` : prefix;
}

/**
 * The reasoning column of a model row: the user's saved level, else the
 * default a run uses; `(fixed)` where the model offers no choice; nothing for
 * a model that never thinks.
 */
function reasoningLevelLabel(
  config: Pick<ModelConfig, 'label' | 'reasoning' | 'modes'>,
  saved: ReasoningEffort | undefined,
): string | undefined {
  if (config.reasoning === undefined) return undefined;
  const fallback = defaultReasoningLevel(config);
  if (fallback === undefined) return 'Default';
  const defaultLevel = REASONING_LEVEL_LABELS[fallback];
  if (!supportsReasoningLevel(config)) return `${defaultLevel} (fixed)`;
  return saved === undefined
    ? `Default (${defaultLevel})`
    : REASONING_LEVEL_LABELS[saved];
}

/** One verdict as a picker row. */
function optionRow(verdict: ModelVerdict): ModelOptionData {
  const { model, availability } = verdict;
  if (!('config' in verdict)) {
    return { value: model, label: model, availability };
  }
  const { config, route, source } = verdict;
  const viaCopilot = availability === 'copilot-allowed';
  const reasoning = viaCopilot
    ? config.reasoning && 'Default (provider managed)'
    : reasoningLevelLabel(config, verdict.savedEffort);
  // The row's identity stays the base model; the badge names the route.
  let routeLabel: string | undefined;
  if (viaCopilot) routeLabel = 'Via Copilot';
  else if (
    isKimiSubscriptionEligible(config) &&
    !isKimiCodeExclusiveModel(config)
  )
    routeLabel = `Via ${route.kind === 'openrouter' ? 'OpenRouter' : providerDisplayName(source)}`;
  // The row ships the verdict's kind alone; `MODEL_AVAILABILITY_STATUS`
  // words it for whichever surface renders it.
  return {
    value: model,
    label: config.label,
    provider: source,
    context: formatContext(config.contextWindow),
    cost: formatCost(config.inputPrice, config.outputPrice),
    // The tooltip describes the model as published; the window and prices
    // are the ones it runs with on its route.
    hint: modelHint(verdict.published),
    ...(reasoning ? { reasoning } : {}),
    ...(routeLabel ? { routeLabel } : {}),
    availability,
  };
}

/** The picker rows for every visible model, in the order they are shown. */
export function modelOptionsFrom(
  inputs: ModelAvailabilityInputs,
): ModelOptionData[] {
  return modelVerdictsFrom(inputs).map(optionRow);
}
