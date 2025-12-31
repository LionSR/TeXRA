import {
  DEFAULT_MODEL_CAPABILITIES,
  ModelCapabilities,
  ModelConfig,
  ModelProvider,
} from '../ModelConfig';

/**
 * Default capabilities for Alibaba DashScope (Qwen) models.
 */
const DASHSCOPE_DEFAULT_CAPABILITIES: ModelCapabilities = {
  ...DEFAULT_MODEL_CAPABILITIES,
  supportsPromptCaching: false,
  supportsVision: true,
  supportsSystemPrompt: true,
};

/**
 * Alibaba DashScope (Qwen) model configurations.
 * Includes Qwen 3 Max, Plus, and Turbo variants.
 */
export const DASHSCOPE_MODELS: Record<string, ModelConfig> = {
  qwen3max: {
    name: 'qwen3max',
    fullName: 'qwen3-max',
    openrouterFullName: 'qwen/qwen-max',
    provider: ModelProvider.DASHSCOPE,
    maxOutputTokens: 65536,
    contextWindow: 262144,
    inputPrice: 1.2,
    outputPrice: 6,
    capabilities: {
      ...DASHSCOPE_DEFAULT_CAPABILITIES,
      supportsVision: false,
    },
    openRouterOnly: false,
  },
  qwenplus: {
    name: 'qwenplus',
    fullName: 'qwen-plus',
    openrouterFullName: 'qwen/qwen-plus',
    provider: ModelProvider.DASHSCOPE,
    maxOutputTokens: 32768,
    contextWindow: 1000000,
    inputPrice: 0.4,
    outputPrice: 1.2,
    capabilities: {
      ...DASHSCOPE_DEFAULT_CAPABILITIES,
      supportsVision: false,
      supportsReasoning: true,
    },
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
    },
    openRouterOnly: false,
  },
};
