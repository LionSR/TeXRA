/**
 * Utility functions for working with model configurations.
 * @packageDocumentation
 */

import { ModelConfig, ModelProvider, ModelCapabilities } from './ModelConfig';
import { MODEL_CONFIGS } from './ModelRegistry';

// ============================================================================
// Model Lookup
// ============================================================================

/**
 * Get a model configuration by its short name.
 * Returns undefined if the model is not found.
 *
 * @param name - The short name of the model (e.g., "sonnet45")
 * @returns The model configuration or undefined
 *
 * @example
 * ```typescript
 * const config = getModel('sonnet45');
 * if (config) {
 *   console.log(config.fullName); // "claude-sonnet-4-5"
 * }
 * ```
 */
export function getModel(name: string): ModelConfig | undefined {
  return MODEL_CONFIGS[name];
}

/**
 * Get a model configuration by its full API name.
 * Searches through all models to find a match.
 *
 * @param fullName - The full API name (e.g., "claude-sonnet-4-5")
 * @returns The model configuration or undefined
 *
 * @example
 * ```typescript
 * const config = getModelByFullName('gpt-4o-2024-11-20');
 * if (config) {
 *   console.log(config.name); // "gpt4o"
 * }
 * ```
 */
export function getModelByFullName(fullName: string): ModelConfig | undefined {
  return Object.values(MODEL_CONFIGS).find((m) => m.fullName === fullName);
}

/**
 * Check if a model exists in the registry.
 *
 * @param name - The short name of the model
 * @returns True if the model exists
 */
export function hasModel(name: string): boolean {
  return name in MODEL_CONFIGS;
}

// ============================================================================
// Model Filtering
// ============================================================================

/**
 * Filter models by provider.
 *
 * @param provider - The provider to filter by
 * @returns Array of model configurations from that provider
 *
 * @example
 * ```typescript
 * const anthropicModels = getModelsByProvider(ModelProvider.ANTHROPIC);
 * console.log(anthropicModels.length); // 21
 * ```
 */
export function getModelsByProvider(provider: ModelProvider): ModelConfig[] {
  return Object.values(MODEL_CONFIGS).filter((m) => m.provider === provider);
}

/**
 * Filter models by a capability predicate.
 *
 * @param predicate - Function that tests model capabilities
 * @returns Array of models matching the predicate
 *
 * @example
 * ```typescript
 * // Get all models with vision support
 * const visionModels = filterByCapability(c => c.supportsVision);
 *
 * // Get all models with reasoning and function calling
 * const reasoningModels = filterByCapability(
 *   c => c.supportsReasoning && c.supportsFunctionCalling
 * );
 * ```
 */
export function filterByCapability(
  predicate: (capabilities: ModelCapabilities) => boolean,
): ModelConfig[] {
  return Object.values(MODEL_CONFIGS).filter((m) => predicate(m.capabilities));
}

/**
 * Get all models that support a specific capability.
 *
 * @param capability - The capability key to check
 * @returns Array of models with that capability enabled
 *
 * @example
 * ```typescript
 * const reasoningModels = getModelsWithCapability('supportsReasoning');
 * const cachingModels = getModelsWithCapability('supportsPromptCaching');
 * ```
 */
export function getModelsWithCapability(
  capability: keyof ModelCapabilities,
): ModelConfig[] {
  return Object.values(MODEL_CONFIGS).filter((m) => {
    const value = m.capabilities[capability];
    return typeof value === 'boolean' ? value : value !== undefined;
  });
}

/**
 * Get models available through a specific access method.
 *
 * @param openRouterOnly - If true, get OpenRouter-only models; if false, get direct API models
 * @returns Array of models matching the access method
 */
export function getModelsByAccess(openRouterOnly: boolean): ModelConfig[] {
  return Object.values(MODEL_CONFIGS).filter(
    (m) => m.openRouterOnly === openRouterOnly,
  );
}

// ============================================================================
// Cost Calculation
// ============================================================================

/**
 * Calculate the cost for a given number of tokens.
 *
 * @param model - The model configuration or name
 * @param inputTokens - Number of input tokens
 * @param outputTokens - Number of output tokens
 * @param cachedInputTokens - Number of cached input tokens (optional)
 * @returns Cost in USD
 *
 * @example
 * ```typescript
 * const cost = calculateCost('sonnet45', 10000, 5000);
 * console.log(`Cost: $${cost.toFixed(4)}`); // Cost: $0.1050
 *
 * // With caching
 * const cachedCost = calculateCost('sonnet45', 10000, 5000, 8000);
 * console.log(`Cached cost: $${cachedCost.toFixed(4)}`);
 * ```
 */
export function calculateCost(
  model: ModelConfig | string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number = 0,
): number {
  const config = typeof model === 'string' ? getModel(model) : model;
  if (!config) {
    throw new Error(`Model not found: ${model}`);
  }

  const uncachedInputTokens = inputTokens - cachedInputTokens;
  const inputCost = (uncachedInputTokens / 1_000_000) * config.inputPrice;
  const cachedCost =
    (cachedInputTokens / 1_000_000) *
    config.inputPrice *
    config.capabilities.cacheDiscountFactor;
  const outputCost = (outputTokens / 1_000_000) * config.outputPrice;

  return inputCost + cachedCost + outputCost;
}

/**
 * Estimate maximum possible cost for a model given context usage.
 *
 * @param model - The model configuration or name
 * @param inputTokens - Number of input tokens
 * @returns Maximum cost if model generates max output tokens
 */
export function estimateMaxCost(
  model: ModelConfig | string,
  inputTokens: number,
): number {
  const config = typeof model === 'string' ? getModel(model) : model;
  if (!config) {
    throw new Error(`Model not found: ${model}`);
  }

  return calculateCost(config, inputTokens, config.maxOutputTokens);
}

// ============================================================================
// Model Comparison
// ============================================================================

/**
 * Compare models by a specific metric.
 *
 * @param metric - The metric to sort by ('price', 'context', 'output')
 * @param ascending - Sort order (default: true for ascending)
 * @returns Sorted array of model configurations
 *
 * @example
 * ```typescript
 * // Get cheapest models first
 * const cheapest = sortModelsByMetric('price', true);
 *
 * // Get models with largest context windows
 * const largestContext = sortModelsByMetric('context', false);
 * ```
 */
export function sortModelsByMetric(
  metric: 'price' | 'context' | 'output',
  ascending: boolean = true,
): ModelConfig[] {
  const models = Object.values(MODEL_CONFIGS);

  const getValue = (m: ModelConfig): number => {
    switch (metric) {
      case 'price':
        return m.inputPrice + m.outputPrice;
      case 'context':
        return m.contextWindow;
      case 'output':
        return m.maxOutputTokens;
    }
  };

  return models.sort((a, b) => {
    const diff = getValue(a) - getValue(b);
    return ascending ? diff : -diff;
  });
}

/**
 * Find the cheapest model that meets specified requirements.
 *
 * @param requirements - Partial capabilities requirements
 * @param minContextWindow - Minimum context window size (optional)
 * @returns The cheapest matching model or undefined
 *
 * @example
 * ```typescript
 * // Find cheapest model with vision support
 * const cheapestVision = findCheapestModel({ supportsVision: true });
 *
 * // Find cheapest reasoning model with at least 100K context
 * const cheapestReasoning = findCheapestModel(
 *   { supportsReasoning: true },
 *   100000
 * );
 * ```
 */
export function findCheapestModel(
  requirements: Partial<ModelCapabilities>,
  minContextWindow?: number,
): ModelConfig | undefined {
  const candidates = Object.values(MODEL_CONFIGS).filter((m) => {
    // Check context window requirement
    if (minContextWindow && m.contextWindow < minContextWindow) {
      return false;
    }

    // Check capability requirements
    for (const [key, value] of Object.entries(requirements)) {
      const capKey = key as keyof ModelCapabilities;
      if (m.capabilities[capKey] !== value) {
        return false;
      }
    }

    return true;
  });

  if (candidates.length === 0) {
    return undefined;
  }

  // Sort by total price and return cheapest
  return candidates.sort(
    (a, b) => a.inputPrice + a.outputPrice - (b.inputPrice + b.outputPrice),
  )[0];
}

// ============================================================================
// Summary Statistics
// ============================================================================

/**
 * Get summary statistics about the model registry.
 *
 * @returns Object with registry statistics
 *
 * @example
 * ```typescript
 * const stats = getRegistryStats();
 * console.log(`Total models: ${stats.totalModels}`);
 * console.log(`Providers: ${stats.providerCounts}`);
 * ```
 */
export function getRegistryStats(): {
  totalModels: number;
  providerCounts: Record<ModelProvider, number>;
  capabilityCounts: Record<keyof ModelCapabilities, number>;
  priceRange: { min: number; max: number };
  contextRange: { min: number; max: number };
} {
  const models = Object.values(MODEL_CONFIGS);

  // Count by provider
  const providerCounts = {} as Record<ModelProvider, number>;
  for (const provider of Object.values(ModelProvider)) {
    providerCounts[provider] = models.filter(
      (m) => m.provider === provider,
    ).length;
  }

  // Count by capability
  const capabilityCounts = {} as Record<keyof ModelCapabilities, number>;
  const capabilityKeys: (keyof ModelCapabilities)[] = [
    'supportsFunctionCalling',
    'supportsNativeMCPServer',
    'supportsNativeWebSearch',
    'supportsNativeCodeExecution',
    'supportsPromptCaching',
    'supportsAutoPromptCaching',
    'supportsReasoning',
    'supportsInterleavedThinking',
    'supportsReasoningEffort',
    'supportsVision',
    'supportsNativePdf',
    'supportsNativeAudio',
    'supportsAssistantPrefill',
    'supportsPredictiveOutput',
    'supportsTokenCounting',
    'supportsSystemPrompt',
    'supportsIntermDevMsgs',
  ];

  for (const key of capabilityKeys) {
    capabilityCounts[key] = models.filter((m) => m.capabilities[key]).length;
  }

  // Price range (combined input + output)
  const prices = models.map((m) => m.inputPrice + m.outputPrice);
  const priceRange = { min: Math.min(...prices), max: Math.max(...prices) };

  // Context range
  const contexts = models.map((m) => m.contextWindow);
  const contextRange = { min: Math.min(...contexts), max: Math.max(...contexts) };

  return {
    totalModels: models.length,
    providerCounts,
    capabilityCounts,
    priceRange,
    contextRange,
  };
}
