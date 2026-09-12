/**
 * The run's price for one completed turn. The package observes token counts
 * and provider-specific extras; the price is a runtime fact stamped on the
 * `response` row beside the dispatch facts (D12), so a resumed run's cost is
 * the sum of its rows and nothing else.
 */
import { ModelProvider, type ModelConfig } from 'llm-zoo';

import type { AgentTrace } from '@agent/trace';
import type { TurnResult } from '@llm/turn';
import type { NormalizedUsage } from '@shared/schemas';

import type { BoundModel } from './modelBinding';

type TurnUsage = NonNullable<TurnResult['usage']>;

/** The per-million rates one turn bills at, and its cache-read rebate. */
interface TurnRates {
  readonly inputPrice: number;
  readonly outputPrice: number;
  readonly cacheDiscountFactor: number;
}

/** Prices are per million tokens. */
const perMillion = (tokens: number, price: number): number =>
  (tokens * price) / 1e6;

/**
 * xAI pricing the llm-zoo catalog cannot express: per-model long-context
 * tiers and the documented cached-token rate, keyed by catalog `fullName`.
 * Source: the models catalog embedded in docs.x.ai, verified 2026-08-14.
 * llm-zoo has no tier field (still true at 1.28.0) and its xAI entries
 * inherit the default `cacheDiscountFactor` of 1, which would zero the
 * cache rebate, so both live here until the catalog carries them (#10073).
 * Rates are USD per 1M tokens.
 */
const XAI_DOCUMENTED_PRICING: Readonly<
  Record<
    string,
    {
      readonly thresholdTokens: number;
      readonly inputPrice: number;
      readonly outputPrice: number;
      readonly cacheDiscountFactor: number;
    }
  >
> = {
  'grok-4.3': {
    thresholdTokens: 200_000,
    inputPrice: 2.5,
    outputPrice: 5,
    cacheDiscountFactor: 0.16,
  },
  'grok-4.5': {
    thresholdTokens: 200_000,
    inputPrice: 4,
    outputPrice: 12,
    cacheDiscountFactor: 0.15,
  },
  'grok-4.6': {
    thresholdTokens: 200_000,
    inputPrice: 4,
    outputPrice: 12,
    cacheDiscountFactor: 0.25,
  },
};

/** Lowest documented threshold; the drift tripwire's reference. */
const LOWEST_XAI_THRESHOLD_TOKENS = Math.min(
  ...Object.values(XAI_DOCUMENTED_PRICING).map(
    (documented) => documented.thresholdTokens,
  ),
);

/** Models already reported as missing a tier; the warning is once per model. */
const xaiTierGapWarned = new Set<string>();

/**
 * A live xAI model whose window reaches the lowest documented threshold but
 * which has no row above would silently bill flat rates, so it warns once.
 */
function warnOnMissingXaiTier(config: ModelConfig, logger: AgentTrace): void {
  if (
    config.deprecated === true ||
    config.retired === true ||
    config.contextWindow < LOWEST_XAI_THRESHOLD_TOKENS ||
    xaiTierGapWarned.has(config.fullName)
  ) {
    return;
  }
  xaiTierGapWarned.add(config.fullName);
  logger.warn(
    `xAI model ${config.fullName} has no documented long-context pricing ` +
      'tier; billing flat catalog rates. If xAI publishes a tier for it, ' +
      'add it to XAI_DOCUMENTED_PRICING in pricing.ts.',
    {
      data: {
        fullName: config.fullName,
        contextWindow: config.contextWindow,
      },
    },
  );
}

/**
 * The rates for one turn. A plan route (ChatGPT/Codex, Grok, the GLM coding
 * plan, Kimi Code) is covered by the subscription, so every rate is zero and
 * the run records tokens without spend; an API-key route bills the registry's
 * rates for the bound model.
 *
 * xAI is the one provider whose rates are not flat: once a request's whole
 * prompt — cached tokens included — reaches the model's documented threshold,
 * every token of that request bills at the tier, output included, so the
 * complete tuple switches and the rebate below follows it.
 */
function turnRates(
  bound: BoundModel,
  plan: boolean,
  promptTokens: number,
  logger: AgentTrace,
): TurnRates {
  const { config } = bound;
  if (plan) return { inputPrice: 0, outputPrice: 0, cacheDiscountFactor: 1 };
  const base = {
    inputPrice: config.inputPrice,
    outputPrice: config.outputPrice,
    cacheDiscountFactor: config.capabilities.cacheDiscountFactor,
  };
  if (config.provider !== ModelProvider.XAI) return base;
  const documented = XAI_DOCUMENTED_PRICING[config.fullName];
  if (documented === undefined) {
    warnOnMissingXaiTier(config, logger);
    return base;
  }
  const { cacheDiscountFactor } = documented;
  return promptTokens >= documented.thresholdTokens
    ? {
        inputPrice: documented.inputPrice,
        outputPrice: documented.outputPrice,
        cacheDiscountFactor,
      }
    : { ...base, cacheDiscountFactor };
}

/**
 * Anthropic bills cache reads and writes as separate token classes on top
 * of the uncached input: reads at a tenth of the input rate, five-minute
 * writes at 1.25x and one-hour writes at 2x.
 */
function anthropicCost(
  usage: TurnUsage,
  provider: Extract<TurnUsage['providerUsage'], { kind: 'anthropic' }>,
  rates: TurnRates,
): number {
  const { inputPrice, outputPrice } = rates;
  const uncached = provider.uncachedInputTokens ?? usage.inputTokens ?? 0;
  const cached = usage.cachedInputTokens ?? 0;
  const write5m =
    provider.cacheCreation5mTokens ??
    (provider.cacheCreation1hTokens === null
      ? (provider.cacheCreationTokens ?? 0)
      : 0);
  const write1h = provider.cacheCreation1hTokens ?? 0;
  return (
    perMillion(uncached, inputPrice) +
    perMillion(cached, inputPrice * 0.1) +
    perMillion(write5m, inputPrice * 1.25) +
    perMillion(write1h, inputPrice * 2) +
    perMillion(usage.outputTokens ?? 0, outputPrice)
  );
}

/**
 * Inclusive-cache cost: cached prompt tokens are a subset of the reported
 * input, billed at the input rate and rebated down to the model's cache
 * discount; reasoning tokens bill at the output rate on top of the output
 * count only where the provider reports them separately.
 */
function standardCost(
  usage: TurnUsage,
  rates: TurnRates,
  reasoningBilledSeparately: boolean,
): number {
  const { inputPrice, outputPrice, cacheDiscountFactor } = rates;
  const inputTokens = usage.inputTokens ?? 0;
  const cached = usage.cachedInputTokens ?? 0;
  const reasoning = reasoningBilledSeparately
    ? (usage.reasoningTokens ?? 0)
    : 0;
  return (
    perMillion(inputTokens, inputPrice) +
    perMillion(usage.outputTokens ?? 0, outputPrice) +
    perMillion(reasoning, outputPrice) -
    perMillion(cached, inputPrice * (1 - cacheDiscountFactor))
  );
}

/**
 * The priced usage of one turn, or `null` when the provider reported none.
 * A credit-backed OpenRouter receipt carries its own settled cost, which wins
 * over a price computed from the registry's per-provider rates. A plan route
 * bills neither: the subscription already paid for the call, and a receipt the
 * provider settled bills an API key that this turn did not use.
 */
export function priceTurnUsage(
  bound: BoundModel,
  usage: TurnResult['usage'],
  responseTimeMs: number,
  logger: AgentTrace,
): NormalizedUsage | null {
  if (usage === null) return null;
  const provider = usage.providerUsage;
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const cached = usage.cachedInputTokens ?? undefined;
  const reasoning = usage.reasoningTokens ?? undefined;
  const plan = bound.usageRoute !== 'api-key';
  const rates = turnRates(bound, plan, inputTokens, logger);
  let cost: number;
  let cacheCreationTokens: number | undefined;
  let toolUsePromptTokens: number | undefined;
  switch (provider?.kind) {
    case 'anthropic':
      cost = anthropicCost(usage, provider, rates);
      cacheCreationTokens = provider.cacheCreationTokens ?? undefined;
      break;
    case 'openrouter':
      // BYOK splits billing across accounts, so the settled figure is not
      // what this key paid: keep the full-inference estimate. A credit-backed
      // request bills the reported cost, including a reported zero.
      cost =
        !plan && provider.isByok !== true && provider.cost != null
          ? provider.cost
          : standardCost(usage, rates, false);
      cacheCreationTokens =
        provider.inputDetails?.cacheWriteTokens ?? undefined;
      break;
    case 'google':
      cost = standardCost(usage, rates, false);
      toolUsePromptTokens = provider.toolUsePromptTokens ?? undefined;
      break;
    case 'xai':
      cost =
        !plan && provider.costInUsdTicks !== null
          ? provider.costInUsdTicks / 1e10
          : standardCost(usage, rates, true);
      break;
    case 'minimax':
    case undefined:
      // Keyed on the wire surface, not the vendor: the OpenAI chat-completions
      // surface reports reasoning tokens outside its output count, so they
      // bill on top. An editor (`vscode-lm`) turn never reaches here with a
      // usage record — the editor model reports `usage: null` and this
      // function returns above — so no editor turn is silently billing
      // reasoning at zero; a future editor model that starts reporting usage
      // needs its own arm rather than this flag.
      cost = standardCost(
        usage,
        rates,
        bound.origin.protocol === 'openai-chat',
      );
      break;
  }
  return {
    inputTokens,
    outputTokens,
    cost: Math.max(0, cost),
    responseTimeMs,
    provider: bound.origin.protocol,
    usageRoute: bound.usageRoute,
    ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
    ...(cached !== undefined && inputTokens >= cached
      ? { cacheMissInputTokens: inputTokens - cached }
      : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
    ...(toolUsePromptTokens !== undefined ? { toolUsePromptTokens } : {}),
  };
}
