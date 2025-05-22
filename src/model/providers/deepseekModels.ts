import {
  DEFAULT_MODEL_CAPABILITIES,
  ModelCapabilities,
  ModelConfig,
  ModelProvider,
  ReasoningEffort,
} from '../ModelConfig';

// Common capabilities for DeepSeek models
const DEEPSEEK_DEFAULT_CAPABILITIES: ModelCapabilities = {
  ...DEFAULT_MODEL_CAPABILITIES,
  supportsAutoPromptCaching: true,
  cacheDiscountFactor: 0.5,
  supportsVision: false,
};

export const DEEPSEEK_MODELS: Record<string, ModelConfig> = {
  DSV3: {
    name: 'DSV3',
    fullName: 'deepseek-chat',
    openrouterFullName: 'deepseek/deepseek-chat',
    provider: ModelProvider.DEEPSEEK,
    maxOutputTokens: 64000,
    contextWindow: 128000,
    inputPrice: 0.14,
    outputPrice: 0.28,
    capabilities: {
      ...DEEPSEEK_DEFAULT_CAPABILITIES,
      supportsAssistantPrefill: true,
    } satisfies ModelCapabilities,
    openRouterOnly: false,
  },
  DSR1: {
    name: 'DSR1',
    fullName: 'deepseek-reasoner',
    openrouterFullName: 'deepseek/deepseek-R1',
    provider: ModelProvider.DEEPSEEK,
    maxOutputTokens: 65536,
    contextWindow: 128000,
    inputPrice: 4,
    outputPrice: 4,
    capabilities: {
      ...DEEPSEEK_DEFAULT_CAPABILITIES,
      supportsReasoning: true,
      supportsReasoningEffort: false,
    } satisfies ModelCapabilities,
    openRouterOnly: false,
  },
  DSV3o: {
    name: 'DSV3o',
    fullName: 'deepseek-chat',
    openrouterFullName: 'deepseek/deepseek-chat-v3-0324',
    provider: ModelProvider.DEEPSEEK,
    maxOutputTokens: 8192,
    contextWindow: 64000,
    inputPrice: 0.27,
    outputPrice: 1.1,
    capabilities: {
      ...DEEPSEEK_DEFAULT_CAPABILITIES,
      supportsAssistantPrefill: true,
    } satisfies ModelCapabilities,
    openRouterOnly: false,
  },
  DSR1o: {
    name: 'DSR1o',
    fullName: 'deepseek-reasoner',
    openrouterFullName: 'deepseek/deepseek-R1',
    provider: ModelProvider.DEEPSEEK,
    maxOutputTokens: 8192,
    contextWindow: 64000,
    inputPrice: 0.55,
    outputPrice: 2.19,
    capabilities: {
      ...DEEPSEEK_DEFAULT_CAPABILITIES,
      supportsReasoning: true,
      supportsReasoningEffort: false,
    } satisfies ModelCapabilities,
    openRouterOnly: false,
  },
};
