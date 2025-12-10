// Local imports
import {
  DEFAULT_MODEL_CAPABILITIES,
  ModelCapabilities,
  ModelConfig,
  ModelProvider,
} from '@model/ModelConfig';

// Common capabilities for DeepSeek V3.2 models
// Cache discount: $0.028 (cache hit) / $0.28 (cache miss) = 0.1
const DEEPSEEK_DEFAULT_CAPABILITIES: ModelCapabilities = {
  ...DEFAULT_MODEL_CAPABILITIES,
  supportsAutoPromptCaching: true,
  cacheDiscountFactor: 0.1,
  supportsVision: false,
};

export const DEEPSEEK_MODELS: Record<string, ModelConfig> = {
  // DeepSeek-V3.2 (Non-thinking Mode)
  // Context: 128K, Max output: 8K, Supports: JSON Output, Tool Calls, Chat Prefix Completion, FIM
  deepseek: {
    name: 'deepseek',
    fullName: 'deepseek-chat',
    openrouterFullName: 'deepseek/deepseek-chat-v3.1',
    provider: ModelProvider.DEEPSEEK,
    maxOutputTokens: 8192,
    contextWindow: 128000,
    inputPrice: 0.28,
    outputPrice: 0.42,
    capabilities: {
      ...DEEPSEEK_DEFAULT_CAPABILITIES,
      supportsAssistantPrefill: true,
      supportsFunctionCalling: true,
    } satisfies ModelCapabilities,
    openRouterOnly: false,
  },
  // DeepSeek-V3.2 (Thinking Mode)
  // Context: 128K, Max output: 64K, Supports: JSON Output, Tool Calls, Chat Prefix Completion
  deepseekT: {
    name: 'deepseekT',
    fullName: 'deepseek-reasoner',
    openrouterFullName: 'deepseek/deepseek-reasoner-v3.1',
    provider: ModelProvider.DEEPSEEK,
    maxOutputTokens: 65536,
    contextWindow: 128000,
    inputPrice: 0.28,
    outputPrice: 0.42,
    capabilities: {
      ...DEEPSEEK_DEFAULT_CAPABILITIES,
      supportsReasoning: true,
      supportsReasoningEffort: false,
      supportsFunctionCalling: true,
    } satisfies ModelCapabilities,
    openRouterOnly: false,
  },
  // DeepSeek-V3.2-Speciale (Thinking Mode Only)
  // Context: 128K, Max output: 128K, No Tool Calls, No JSON Output, No Chat Prefix Completion
  // Available until December 15, 2025
  'deepseekT+': {
    name: 'deepseekT+',
    fullName: 'deepseek-reasoner',
    openrouterFullName: 'deepseek/deepseek-v3.2-speciale',
    provider: ModelProvider.DEEPSEEK,
    maxOutputTokens: 131072,
    contextWindow: 128000,
    inputPrice: 0.28,
    outputPrice: 0.42,
    capabilities: {
      ...DEEPSEEK_DEFAULT_CAPABILITIES,
      supportsReasoning: true,
      supportsReasoningEffort: false,
      supportsFunctionCalling: false,
      supportsAssistantPrefill: false,
    } satisfies ModelCapabilities,
    openRouterOnly: false,
    baseUrl: 'https://api.deepseek.com/v3.2_speciale_expires_on_20251215',
  },
  dsv3: {
    name: 'dsv3',
    fullName: 'deepseek-chat',
    openrouterFullName: 'deepseek/deepseek-chat-v3-0324',
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
  dsr1: {
    name: 'dsr1',
    fullName: 'deepseek-reasoner',
    openrouterFullName: 'deepseek/deepseek-r1-0528',
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
  dsv3o: {
    name: 'dsv3o',
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
  dsr1o: {
    name: 'dsr1o',
    fullName: 'deepseek-reasoner',
    openrouterFullName: 'deepseek/deepseek-r1-0528',
    provider: ModelProvider.DEEPSEEK,
    maxOutputTokens: 64000,
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
