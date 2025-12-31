/**
 * Utility functions for working with model configurations.
 * @packageDocumentation
 */

import { ModelConfig, ModelProvider, ModelCapabilities } from './ModelConfig';
import { MODEL_CONFIGS } from './ModelRegistry';

// ============================================================================
// Lookup
// ============================================================================

/**
 * Get a model by short name.
 *
 * @example
 * ```typescript
 * const claude = lookup('sonnet45');
 * const gpt = lookup('gpt4o');
 * ```
 */
export function lookup(name: string): ModelConfig | undefined {
  return MODEL_CONFIGS[name];
}

/**
 * Resolve a model by its full API identifier.
 *
 * @example
 * ```typescript
 * const model = resolve('claude-sonnet-4-5');
 * const model2 = resolve('gpt-4o-2024-11-20');
 * ```
 */
export function resolve(fullName: string): ModelConfig | undefined {
  return Object.values(MODEL_CONFIGS).find((m) => m.fullName === fullName);
}

/**
 * Check if a model exists.
 */
export function exists(name: string): boolean {
  return name in MODEL_CONFIGS;
}

// ============================================================================
// Filtering - Fluent Predicates
// ============================================================================

/**
 * Get all models from a provider.
 *
 * @example
 * ```typescript
 * const claudeModels = from(ModelProvider.ANTHROPIC);
 * const geminiModels = from(ModelProvider.GOOGLE);
 * ```
 */
export function from(provider: ModelProvider): ModelConfig[] {
  return Object.values(MODEL_CONFIGS).filter((m) => m.provider === provider);
}

/**
 * Find models matching a capability predicate.
 *
 * @example
 * ```typescript
 * // Vision + reasoning models
 * const smart = where(c => c.supportsVision && c.supportsReasoning);
 *
 * // Models with great caching
 * const cached = where(c => c.cacheDiscountFactor <= 0.1);
 * ```
 */
export function where(
  predicate: (capabilities: ModelCapabilities) => boolean,
): ModelConfig[] {
  return Object.values(MODEL_CONFIGS).filter((m) => predicate(m.capabilities));
}

/**
 * Get models supporting a specific capability.
 *
 * @example
 * ```typescript
 * const reasoners = supporting('supportsReasoning');
 * const visionaries = supporting('supportsVision');
 * const coders = supporting('supportsNativeCodeExecution');
 * ```
 */
export function supporting(
  capability: keyof ModelCapabilities,
): ModelConfig[] {
  return Object.values(MODEL_CONFIGS).filter((m) => {
    const value = m.capabilities[capability];
    return typeof value === 'boolean' ? value : value !== undefined;
  });
}

/**
 * Filter by context window size.
 *
 * @example
 * ```typescript
 * const longContext = withContext(200000);  // 200K+ context
 * const million = withContext(1000000);     // 1M+ context
 * ```
 */
export function withContext(minTokens: number): ModelConfig[] {
  return Object.values(MODEL_CONFIGS).filter(
    (m) => m.contextWindow >= minTokens,
  );
}

/**
 * Get models accessible via direct API (not OpenRouter-only).
 */
export function directAccess(): ModelConfig[] {
  return Object.values(MODEL_CONFIGS).filter((m) => !m.openRouterOnly);
}

/**
 * Get models only available through OpenRouter.
 */
export function openRouterOnly(): ModelConfig[] {
  return Object.values(MODEL_CONFIGS).filter((m) => m.openRouterOnly);
}

// ============================================================================
// Cost Intelligence
// ============================================================================

/**
 * Calculate exact cost for a request.
 *
 * @example
 * ```typescript
 * // Basic usage
 * const price = cost('sonnet45', { input: 10000, output: 5000 });
 *
 * // With prompt caching
 * const cached = cost('sonnet45', {
 *   input: 10000,
 *   output: 5000,
 *   cached: 8000  // 8K tokens were cache hits
 * });
 * ```
 */
export function cost(
  model: ModelConfig | string,
  tokens: { input: number; output: number; cached?: number },
): number {
  const config = typeof model === 'string' ? lookup(model) : model;
  if (!config) {
    throw new Error(`Unknown model: ${model}`);
  }

  const { input, output, cached = 0 } = tokens;
  const uncached = input - cached;

  const inputCost = (uncached / 1_000_000) * config.inputPrice;
  const cacheCost =
    (cached / 1_000_000) * config.inputPrice * config.capabilities.cacheDiscountFactor;
  const outputCost = (output / 1_000_000) * config.outputPrice;

  return inputCost + cacheCost + outputCost;
}

/**
 * Estimate worst-case cost (max output tokens).
 *
 * @example
 * ```typescript
 * const worst = maxCost('gpt4o', 50000);
 * console.log(`Budget up to $${worst.toFixed(2)}`);
 * ```
 */
export function maxCost(model: ModelConfig | string, inputTokens: number): number {
  const config = typeof model === 'string' ? lookup(model) : model;
  if (!config) {
    throw new Error(`Unknown model: ${model}`);
  }
  return cost(config, { input: inputTokens, output: config.maxOutputTokens });
}

/**
 * Compare cost across models for the same workload.
 *
 * @example
 * ```typescript
 * const comparison = compareCosts(
 *   ['sonnet45', 'gpt4o', 'gemini25p'],
 *   { input: 10000, output: 2000 }
 * );
 * // Returns sorted by cost: [{ model, cost }, ...]
 * ```
 */
export function compareCosts(
  models: (ModelConfig | string)[],
  tokens: { input: number; output: number; cached?: number },
): { model: ModelConfig; cost: number }[] {
  return models
    .map((m) => {
      const config = typeof m === 'string' ? lookup(m) : m;
      if (!config) throw new Error(`Unknown model: ${m}`);
      return { model: config, cost: cost(config, tokens) };
    })
    .sort((a, b) => a.cost - b.cost);
}

// ============================================================================
// Smart Selection
// ============================================================================

/**
 * Find the cheapest model meeting your requirements.
 *
 * @example
 * ```typescript
 * // Cheapest with vision
 * const budget = cheapest({ supportsVision: true });
 *
 * // Cheapest reasoning model with 100K+ context
 * const thinker = cheapest(
 *   { supportsReasoning: true },
 *   { minContext: 100000 }
 * );
 * ```
 */
export function cheapest(
  capabilities: Partial<ModelCapabilities>,
  options?: { minContext?: number; provider?: ModelProvider },
): ModelConfig | undefined {
  const candidates = Object.values(MODEL_CONFIGS).filter((m) => {
    if (options?.minContext && m.contextWindow < options.minContext) {
      return false;
    }
    if (options?.provider && m.provider !== options.provider) {
      return false;
    }
    for (const [key, value] of Object.entries(capabilities)) {
      if (m.capabilities[key as keyof ModelCapabilities] !== value) {
        return false;
      }
    }
    return true;
  });

  if (candidates.length === 0) return undefined;

  return candidates.sort(
    (a, b) => a.inputPrice + a.outputPrice - (b.inputPrice + b.outputPrice),
  )[0];
}

/**
 * Find the most capable model within a budget.
 * Returns the priciest model under the limit (more expensive = usually better).
 *
 * @example
 * ```typescript
 * // Best model under $5/1M combined tokens
 * const best = smartpick(5);
 *
 * // Best reasoning model under $10
 * const bestReasoner = smartpick(10, { supportsReasoning: true });
 * ```
 */
export function smartpick(
  maxPricePerMillion: number,
  capabilities?: Partial<ModelCapabilities>,
): ModelConfig | undefined {
  let candidates = Object.values(MODEL_CONFIGS).filter(
    (m) => m.inputPrice + m.outputPrice <= maxPricePerMillion,
  );

  if (capabilities) {
    candidates = candidates.filter((m) => {
      for (const [key, value] of Object.entries(capabilities)) {
        if (m.capabilities[key as keyof ModelCapabilities] !== value) {
          return false;
        }
      }
      return true;
    });
  }

  if (candidates.length === 0) return undefined;

  // Higher price generally = more capable, so return the priciest under budget
  return candidates.sort(
    (a, b) => (b.inputPrice + b.outputPrice) - (a.inputPrice + a.outputPrice),
  )[0];
}

/**
 * Rank models by a metric.
 *
 * @example
 * ```typescript
 * const byPrice = ranked('price');        // Cheapest first
 * const byContext = ranked('context', 'desc');  // Largest context first
 * const byOutput = ranked('output', 'desc');    // Most output first
 * ```
 */
export function ranked(
  by: 'price' | 'context' | 'output',
  order: 'asc' | 'desc' = 'asc',
): ModelConfig[] {
  const getValue = (m: ModelConfig): number => {
    switch (by) {
      case 'price':
        return m.inputPrice + m.outputPrice;
      case 'context':
        return m.contextWindow;
      case 'output':
        return m.maxOutputTokens;
    }
  };

  return Object.values(MODEL_CONFIGS).sort((a, b) => {
    const diff = getValue(a) - getValue(b);
    return order === 'asc' ? diff : -diff;
  });
}

// ============================================================================
// Insights
// ============================================================================

/**
 * Get registry statistics and insights.
 *
 * @example
 * ```typescript
 * const { totalModels, providers, capabilities } = insights();
 * console.log(`${totalModels} models across ${Object.keys(providers).length} providers`);
 * ```
 */
export function insights(): {
  totalModels: number;
  providers: Record<ModelProvider, number>;
  capabilities: Record<string, number>;
  pricing: { cheapest: ModelConfig; mostExpensive: ModelConfig };
  context: { smallest: ModelConfig; largest: ModelConfig };
} {
  const models = Object.values(MODEL_CONFIGS);

  // Count by provider
  const providers = {} as Record<ModelProvider, number>;
  for (const provider of Object.values(ModelProvider)) {
    providers[provider] = models.filter((m) => m.provider === provider).length;
  }

  // Count by capability
  const capabilityKeys = [
    'supportsFunctionCalling',
    'supportsReasoning',
    'supportsVision',
    'supportsNativeCodeExecution',
    'supportsNativeWebSearch',
    'supportsPromptCaching',
    'supportsNativePdf',
    'supportsNativeAudio',
  ];

  const capabilities: Record<string, number> = {};
  for (const key of capabilityKeys) {
    const shortKey = key.replace('supports', '').replace('Native', '');
    capabilities[shortKey] = models.filter(
      (m) => m.capabilities[key as keyof ModelCapabilities],
    ).length;
  }

  // Extremes
  const byPrice = [...models].sort(
    (a, b) => a.inputPrice + a.outputPrice - (b.inputPrice + b.outputPrice),
  );
  const byContext = [...models].sort((a, b) => a.contextWindow - b.contextWindow);

  return {
    totalModels: models.length,
    providers,
    capabilities,
    pricing: {
      cheapest: byPrice[0]!,
      mostExpensive: byPrice[byPrice.length - 1]!,
    },
    context: {
      smallest: byContext[0]!,
      largest: byContext[byContext.length - 1]!,
    },
  };
}

// ============================================================================
// Legacy Aliases (backward compatibility)
// ============================================================================

/** @deprecated Use `lookup()` instead */
export const getModel = lookup;
/** @deprecated Use `resolve()` instead */
export const getModelByFullName = resolve;
/** @deprecated Use `exists()` instead */
export const hasModel = exists;
/** @deprecated Use `from()` instead */
export const getModelsByProvider = from;
/** @deprecated Use `where()` instead */
export const filterByCapability = where;
/** @deprecated Use `supporting()` instead */
export const getModelsWithCapability = supporting;
/** @deprecated Use `cost()` instead */
export function calculateCost(
  model: ModelConfig | string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number = 0,
): number {
  return cost(model, { input: inputTokens, output: outputTokens, cached: cachedInputTokens });
}
/** @deprecated Use `maxCost()` instead */
export const estimateMaxCost = maxCost;
/** @deprecated Use `ranked()` instead */
export function sortModelsByMetric(
  metric: 'price' | 'context' | 'output',
  ascending: boolean = true,
): ModelConfig[] {
  return ranked(metric, ascending ? 'asc' : 'desc');
}
/** @deprecated Use `cheapest()` instead */
export function findCheapestModel(
  requirements: Partial<ModelCapabilities>,
  minContextWindow?: number,
): ModelConfig | undefined {
  return cheapest(requirements, minContextWindow !== undefined ? { minContext: minContextWindow } : {});
}
/** @deprecated Use `insights()` instead */
export const getRegistryStats = insights;
