// Local imports
import {
  DEFAULT_MODEL_CAPABILITIES,
  ModelCapabilities,
  ModelConfig,
  ModelProvider,
  ReasoningEffort,
} from '../ModelConfig';

// Common capabilities for DashScope models
const DASHSCOPE_DEFAULT_CAPABILITIES: ModelCapabilities = {
  ...DEFAULT_MODEL_CAPABILITIES,
  supportsPromptCaching: false,
  supportsVision: true,
  supportsSystemPrompt: true,
};

export const DASHSCOPE_MODELS: Record<string, ModelConfig> = {
  qwen3max: {
    name: 'qwen3max',
    fullName: 'qwen-max-latest',
    openrouterFullName: 'qwen/qwen-max',
    provider: ModelProvider.DASHSCOPE,
    maxOutputTokens: 25600, // maximal is 32768 but there are also text input and tool use tokens
    contextWindow: 262144,
    inputPrice: 1.6,
    outputPrice: 6.4,
    capabilities: {
      ...DASHSCOPE_DEFAULT_CAPABILITIES,
      supportsVision: false,
    } satisfies ModelCapabilities,
    openRouterOnly: true,
  },
  qwenplus: {
    name: 'qwenplus',
    fullName: 'qwen-plus-latest',
    openrouterFullName: 'qwen/qwen-plus',
    provider: ModelProvider.DASHSCOPE,
    maxOutputTokens: 25600, // maximal is 32768 but there are also text input and tool use tokens
    contextWindow: 1000000,
    inputPrice: 0.4,
    outputPrice: 1.2,
    capabilities: {
      ...DASHSCOPE_DEFAULT_CAPABILITIES,
      supportsVision: false,
      supportsReasoning: true,
    } satisfies ModelCapabilities,
    openRouterOnly: false,
  },
  qwenturbo: {
    name: 'qwenturbo',
    fullName: 'qwen-turbo-latest',
    openrouterFullName: 'qwen/qwen-turbo',
    provider: ModelProvider.DASHSCOPE,
    maxOutputTokens: 8192,
    contextWindow: 131072,
    inputPrice: 0.05,
    outputPrice: 0.5,
    capabilities: {
      ...DASHSCOPE_DEFAULT_CAPABILITIES,
      supportsVision: false,
      supportsReasoning: true,
    } satisfies ModelCapabilities,
    openRouterOnly: false,
  },
};
