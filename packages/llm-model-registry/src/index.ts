/**
 * LLM Model Registry - A comprehensive database of LLM model configurations
 *
 * This package provides detailed configuration data for language models from
 * major providers including Anthropic, OpenAI, Google, DeepSeek, xAI, and more.
 *
 * @packageDocumentation
 *
 * @example Basic Usage
 * ```typescript
 * import { MODEL_CONFIGS, getModel, ModelProvider } from 'llm-model-registry';
 *
 * // Access model configuration directly
 * const sonnet = MODEL_CONFIGS['sonnet45'];
 * console.log(sonnet.contextWindow); // 200000
 *
 * // Use helper function
 * const gpt4o = getModel('gpt4o');
 * console.log(gpt4o?.capabilities.supportsVision); // true
 * ```
 *
 * @example Cost Calculation
 * ```typescript
 * import { calculateCost } from 'llm-model-registry';
 *
 * const cost = calculateCost('sonnet45', 10000, 5000);
 * console.log(`Cost: $${cost.toFixed(4)}`);
 * ```
 *
 * @example Filtering Models
 * ```typescript
 * import { filterByCapability, getModelsByProvider, ModelProvider } from 'llm-model-registry';
 *
 * // Get all reasoning models
 * const reasoningModels = filterByCapability(c => c.supportsReasoning);
 *
 * // Get all Anthropic models
 * const anthropicModels = getModelsByProvider(ModelProvider.ANTHROPIC);
 * ```
 */

// Core types and interfaces
export {
  ModelConfig,
  ModelCapabilities,
  ModelProvider,
  ReasoningEffort,
  DEFAULT_MODEL_CAPABILITIES,
  DEFAULT_CONTEXT_WINDOW,
} from './ModelConfig';

// Model registry
export {
  MODEL_CONFIGS,
  MODELS,
  // Individual provider exports
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

// Utility functions
export {
  // Lookup
  getModel,
  getModelByFullName,
  hasModel,
  // Filtering
  getModelsByProvider,
  filterByCapability,
  getModelsWithCapability,
  getModelsByAccess,
  // Cost calculation
  calculateCost,
  estimateMaxCost,
  // Comparison
  sortModelsByMetric,
  findCheapestModel,
  // Statistics
  getRegistryStats,
} from './utils';
