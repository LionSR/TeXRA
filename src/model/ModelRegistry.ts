/**
 * Registry of available language model configurations with pricing and capabilities.
 * Models are grouped by provider (Anthropic, OpenAI, Google) and include:
 * - Model identifiers and versions
 * - Context window and token limits
 * - Pricing for input/output tokens
 * - Provider-specific capabilities
 */

// Local imports - agent components
import { ModelConfig } from './ModelConfig';
import {
  ANTHROPIC_MODELS,
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
 * Available model configurations indexed by short name.
 * Each configuration includes complete model settings and capabilities.
 */
export const MODEL_CONFIGS: Record<string, ModelConfig> = {
  ...ANTHROPIC_MODELS,
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
 * List of all available model short names.
 * Derived from MODEL_CONFIGS for single source of truth.
 */
export const MODELS = Object.keys(MODEL_CONFIGS);
