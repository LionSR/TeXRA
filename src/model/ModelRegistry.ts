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

import { ANTHROPIC_MODELS } from './providers/anthropicModels';
import { OPENAI_REASONING_MODELS } from './providers/openaiReasoningModels';
import { OPENAI_MODELS } from './providers/openaiModels';
import { GOOGLE_MODELS } from './providers/googleModels';
import { XAI_MODELS } from './providers/xaiModels';
import { OTHER_MODELS } from './providers/otherModels';
import { DEEPSEEK_MODELS } from './providers/deepseekModels';
import { MOONSHOT_MODELS } from './providers/moonshotModels';
import { DASHSCOPE_MODELS } from './providers/dashscopeModels';

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
};
