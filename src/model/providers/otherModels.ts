import {
  DEFAULT_MODEL_CAPABILITIES,
  ModelCapabilities,
  ModelConfig,
  ModelProvider,
  ReasoningEffort,
} from '../ModelConfig';

// ===== OpenRouter Models =====

// Common capabilities for Other/OpenRouter models
const OTHER_DEFAULT_CAPABILITIES: ModelCapabilities = {
  ...DEFAULT_MODEL_CAPABILITIES,
};

export const OTHER_MODELS: Record<string, ModelConfig> = {
  llama31: {
    name: 'llama31',
    fullName: 'meta-llama/llama-3.1-405b-instruct',
    openrouterFullName: 'meta-llama/llama-3.1-405b-instruct',
    provider: ModelProvider.OTHERS,
    maxOutputTokens: 131072,
    contextWindow: 131072,
    inputPrice: 3.0,
    outputPrice: 3.0,
    capabilities: OTHER_DEFAULT_CAPABILITIES satisfies ModelCapabilities,
    openRouterOnly: true,
  },
  'qvq-72b': {
    name: 'qvq-72b',
    fullName: 'qwen/qvq-72b-preview',
    openrouterFullName: 'qwen/qvq-72b-preview',
    provider: ModelProvider.OTHERS,
    maxOutputTokens: 4096,
    contextWindow: 128000,
    inputPrice: 0.25,
    outputPrice: 0.5,
    capabilities: {
      ...OTHER_DEFAULT_CAPABILITIES,
    } satisfies ModelCapabilities,
    openRouterOnly: true,
  },
};
