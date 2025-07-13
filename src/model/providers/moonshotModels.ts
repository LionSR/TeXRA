// Local imports
import {
  DEFAULT_MODEL_CAPABILITIES,
  ModelCapabilities,
  ModelConfig,
  ModelProvider,
  ReasoningEffort,
} from '../ModelConfig';

// Common capabilities for Moonshot models
const MOONSHOT_DEFAULT_CAPABILITIES: ModelCapabilities = {
  ...DEFAULT_MODEL_CAPABILITIES,
  supportsPromptCaching: false,
  supportsSystemPrompt: true,
};

export const MOONSHOT_MODELS: Record<string, ModelConfig> = {
  kimi: {
    name: 'kimi128k',
    fullName: 'moonshot-v1-128k',
    openrouterFullName: 'moonshotai/moonshot-v1-128k',
    provider: ModelProvider.MOONSHOT,
    maxOutputTokens: 640000,
    contextWindow: 128000,
    inputPrice: 0.28,
    outputPrice: 1.12,
    capabilities: {
      ...MOONSHOT_DEFAULT_CAPABILITIES,
      supportsVision: false,
    } satisfies ModelCapabilities,
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
    } satisfies ModelCapabilities,
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
    } satisfies ModelCapabilities,
    openRouterOnly: false,
  },
  kimi2: {
    name: 'kimi2',
    fullName: 'kimi-k2-0711-preview',
    openrouterFullName: 'moonshotai/kimi-k2',
    provider: ModelProvider.MOONSHOT,
    maxOutputTokens: 64000,
    contextWindow: 131072,
    inputPrice: 0.57,
    outputPrice: 2.3,
    capabilities: {
      ...MOONSHOT_DEFAULT_CAPABILITIES,
      supportsVision: false,
      supportsReasoning: false,
    } satisfies ModelCapabilities,
    openRouterOnly: false,
  },
};
