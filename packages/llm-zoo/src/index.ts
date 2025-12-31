/**
 * # LLM Zoo
 *
 * A comprehensive database of 70+ language models from 9 providers.
 * Zero dependencies. Full TypeScript. Tree-shakeable.
 *
 * @packageDocumentation
 *
 * @example Quick Start
 * ```typescript
 * import { lookup, cost, cheapest } from 'llm-zoo';
 *
 * // Lookup any model
 * const claude = lookup('sonnet45');
 *
 * // Calculate costs
 * const price = cost('gpt4o', { input: 10000, output: 2000 });
 *
 * // Find the perfect model
 * const budget = cheapest({ supportsVision: true, supportsReasoning: true });
 * ```
 */

// Core types (use `export type` for isolatedModules compatibility)
export type { ModelConfig, ModelCapabilities } from './ModelConfig';
export { ModelProvider, ReasoningEffort, DEFAULT_MODEL_CAPABILITIES, DEFAULT_CONTEXT_WINDOW } from './ModelConfig';

// Registry
export {
  MODEL_CONFIGS,
  MODELS,
  ANTHROPIC_MODELS,
  OPENAI_MODELS,
  OPENAI_REASONING_MODELS,
  OPENAI_DEEP_RESEARCH_MODELS,
  GOOGLE_MODELS,
  DEEPSEEK_MODELS,
  XAI_MODELS,
  MOONSHOT_MODELS,
  DASHSCOPE_MODELS,
  COPILOT_MODELS,
  OTHER_MODELS,
} from './ModelRegistry';

// Utilities
export {
  // Lookup
  lookup,
  resolve,
  exists,
  // Filtering
  from,
  where,
  supporting,
  withContext,
  directAccess,
  openRouterOnly,
  // Cost
  cost,
  maxCost,
  compareCosts,
  // Smart Selection
  cheapest,
  smartpick,
  ranked,
  // Insights
  insights,
  // Legacy (deprecated)
  getModel,
  getModelByFullName,
  hasModel,
  getModelsByProvider,
  filterByCapability,
  getModelsWithCapability,
  calculateCost,
  estimateMaxCost,
  sortModelsByMetric,
  findCheapestModel,
  getRegistryStats,
} from './utils';

// Note: Zod schemas are available via 'llm-zoo/schemas' (requires zod peer dependency)
