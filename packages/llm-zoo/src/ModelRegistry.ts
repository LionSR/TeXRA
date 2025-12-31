/**
 * Central registry of all available language model configurations.
 * This module aggregates model configurations from all providers and
 * exports them as a unified registry.
 *
 * @packageDocumentation
 */

import { ModelConfig } from './ModelConfig';
import {
  ANTHROPIC_MODELS,
  OPENAI_DEEP_RESEARCH_MODELS,
  OPENAI_REASONING_MODELS,
  OPENAI_MODELS,
  GOOGLE_MODELS,
  XAI_MODELS,
  OTHER_MODELS,
  DEEPSEEK_MODELS,
  MOONSHOT_MODELS,
  DASHSCOPE_MODELS,
  COPILOT_MODELS,
} from './providers';

/**
 * Complete registry of all available model configurations.
 * Models are indexed by their short name (e.g., "sonnet45", "gpt4o").
 *
 * @example
 * ```typescript
 * import { MODEL_CONFIGS } from 'llm-model-registry';
 *
 * const sonnetConfig = MODEL_CONFIGS['sonnet45'];
 * console.log(sonnetConfig.contextWindow); // 200000
 * console.log(sonnetConfig.inputPrice);    // 3.0 ($/1M tokens)
 * ```
 */
export const MODEL_CONFIGS: Record<string, ModelConfig> = {
  ...ANTHROPIC_MODELS,
  ...OPENAI_DEEP_RESEARCH_MODELS,
  ...OPENAI_REASONING_MODELS,
  ...OPENAI_MODELS,
  ...GOOGLE_MODELS,
  ...XAI_MODELS,
  ...OTHER_MODELS,
  ...DEEPSEEK_MODELS,
  ...MOONSHOT_MODELS,
  ...DASHSCOPE_MODELS,
  ...COPILOT_MODELS,
};

/**
 * Array of all available model short names.
 * Derived from MODEL_CONFIGS keys.
 *
 * @example
 * ```typescript
 * import { MODELS } from 'llm-model-registry';
 *
 * console.log(MODELS); // ['opus45T', 'opus45', 'sonnet45', ...]
 * ```
 */
export const MODELS = Object.keys(MODEL_CONFIGS);

/**
 * Re-export individual provider model collections for granular access.
 */
export {
  ANTHROPIC_MODELS,
  OPENAI_DEEP_RESEARCH_MODELS,
  OPENAI_REASONING_MODELS,
  OPENAI_MODELS,
  GOOGLE_MODELS,
  XAI_MODELS,
  OTHER_MODELS,
  DEEPSEEK_MODELS,
  MOONSHOT_MODELS,
  DASHSCOPE_MODELS,
  COPILOT_MODELS,
};
