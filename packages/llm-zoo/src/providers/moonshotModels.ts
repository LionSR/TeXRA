import {
  DEFAULT_MODEL_CAPABILITIES,
  ModelCapabilities,
  ModelConfig,
  ModelProvider,
  ReasoningEffort,
} from '../ModelConfig';

/**
 * Default capabilities for Moonshot (Kimi) models.
 */
const MOONSHOT_DEFAULT_CAPABILITIES: ModelCapabilities = {
  ...DEFAULT_MODEL_CAPABILITIES,
  supportsPromptCaching: false,
  supportsSystemPrompt: true,
};

/**
 * Moonshot AI (Kimi) model configurations.
 * Includes Kimi K2 and thinking variants.
 */
export const MOONSHOT_MODELS: Record<string, ModelConfig> = {
  kimi: {
    name: 'kimi128k',
    fullName: 'moonshot-v1-128k',
    openrouterFullName: 'moonshotai/moonshot-v1-128k',
    provider: ModelProvider.MOONSHOT,
    maxOutputTokens: 64000,
    contextWindow: 128000,
    inputPrice: 0.28,
    outputPrice: 1.12,
    capabilities: {
      ...MOONSHOT_DEFAULT_CAPABILITIES,
      supportsVision: false,
    },
    openRouterOnly: false,
  },
  kimiv: {
    name: 'kimi128kv',
    fullName: 'moonshot-v1-128k-vision',
    openrouterFullName: 'moonshotai/moonshot-v1-128k-vision',
    provider: ModelProvider.MOONSHOT,
    maxOutputTokens: 64000,
    contextWindow: 128000,
    inputPrice: 0.35,
    outputPrice: 1.4,
    capabilities: {
      ...MOONSHOT_DEFAULT_CAPABILITIES,
      supportsVision: true,
    },
    openRouterOnly: false,
  },
  kimit: {
    name: 'kimit',
    fullName: 'kimi-thinking-preview',
    openrouterFullName: 'moonshotai/kimi-thinking-preview',
    provider: ModelProvider.MOONSHOT,
    maxOutputTokens: 64000,
    contextWindow: 128000,
    inputPrice: 0.42,
    outputPrice: 1.68,
    capabilities: {
      ...MOONSHOT_DEFAULT_CAPABILITIES,
      supportsVision: true,
      supportsReasoning: true,
    },
    openRouterOnly: false,
  },
  kimi2: {
    name: 'kimi2',
    fullName: 'kimi-k2-0905-preview',
    openrouterFullName: 'moonshotai/kimi-k2-0905',
    provider: ModelProvider.MOONSHOT,
    maxOutputTokens: 64000,
    contextWindow: 262144,
    inputPrice: 0.6,
    outputPrice: 2.5,
    capabilities: {
      ...MOONSHOT_DEFAULT_CAPABILITIES,
      supportsVision: false,
      supportsAutoPromptCaching: true,
      cacheDiscountFactor: 0.25,
      supportsReasoning: false,
    },
    openRouterOnly: false,
  },
  'kimi2+': {
    name: 'kimi2+',
    fullName: 'kimi-k2-turbo-preview',
    openrouterFullName: 'moonshotai/kimi-k2-turbo',
    provider: ModelProvider.MOONSHOT,
    maxOutputTokens: 64000,
    contextWindow: 262144,
    inputPrice: 0.56 * 4,
    outputPrice: 2.22 * 4,
    capabilities: {
      ...MOONSHOT_DEFAULT_CAPABILITIES,
      supportsVision: false,
      supportsAutoPromptCaching: true,
      cacheDiscountFactor: 0.25,
      supportsReasoning: false,
    },
    openRouterOnly: false,
  },
  kimi2T: {
    name: 'kimi2T',
    fullName: 'kimi-k2-thinking',
    openrouterFullName: 'moonshotai/kimi-k2-thinking',
    provider: ModelProvider.MOONSHOT,
    maxOutputTokens: 64000,
    contextWindow: 262144,
    inputPrice: 0.56,
    outputPrice: 2.22,
    capabilities: {
      ...MOONSHOT_DEFAULT_CAPABILITIES,
      supportsVision: false,
      supportsReasoning: true,
      supportsInterleavedThinking: true,
      supportsAutoPromptCaching: true,
      cacheDiscountFactor: 0.25,
      reasoningEffort: ReasoningEffort.HIGH,
    },
    openRouterOnly: false,
  },
  'kimi2T+': {
    name: 'kimi2T+',
    fullName: 'kimi-k2-thinking-turbo',
    openrouterFullName: 'moonshotai/kimi-k2-thinking-turbo',
    provider: ModelProvider.MOONSHOT,
    maxOutputTokens: 64000,
    contextWindow: 262144,
    inputPrice: 0.56 * 4,
    outputPrice: 2.22 * 4,
    capabilities: {
      ...MOONSHOT_DEFAULT_CAPABILITIES,
      supportsVision: false,
      supportsReasoning: true,
      supportsInterleavedThinking: true,
      supportsAutoPromptCaching: true,
      cacheDiscountFactor: 0.25,
      reasoningEffort: ReasoningEffort.HIGH,
    },
    openRouterOnly: false,
  },
};
