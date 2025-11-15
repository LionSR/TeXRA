// Local imports
import {
  DEFAULT_MODEL_CAPABILITIES,
  ModelCapabilities,
  ModelConfig,
  ModelProvider,
  ReasoningEffort,
} from '@model/ModelConfig';

const COPILOT_DEFAULT_CAPABILITIES: ModelCapabilities = {
  ...DEFAULT_MODEL_CAPABILITIES,
  supportsVision: true,
  supportsNativePdf: false,
};

export const COPILOT_MODELS: Record<string, ModelConfig> = {
  copilot4o: {
    name: 'copilot4o',
    fullName: 'gpt-4o', // Family name for VS Code Language Model API
    provider: ModelProvider.COPILOT,
    maxOutputTokens: 8192,
    contextWindow: 128000,
    inputPrice: 0,
    outputPrice: 0,
    capabilities: {
      ...COPILOT_DEFAULT_CAPABILITIES,
      reasoningEffort: ReasoningEffort.MEDIUM,
    } satisfies ModelCapabilities,
    openRouterOnly: false,
  },
  copilot4: {
    name: 'copilot4',
    fullName: 'gpt-4', // Family name for VS Code Language Model API
    provider: ModelProvider.COPILOT,
    maxOutputTokens: 8192,
    contextWindow: 128000,
    inputPrice: 0,
    outputPrice: 0,
    capabilities: {
      ...COPILOT_DEFAULT_CAPABILITIES,
      reasoningEffort: ReasoningEffort.MEDIUM,
    } satisfies ModelCapabilities,
    openRouterOnly: false,
  },
  copilot35: {
    name: 'copilot35',
    fullName: 'gpt-3.5-turbo', // Family name for VS Code Language Model API
    provider: ModelProvider.COPILOT,
    maxOutputTokens: 4096,
    contextWindow: 16385,
    inputPrice: 0,
    outputPrice: 0,
    capabilities: {
      ...COPILOT_DEFAULT_CAPABILITIES,
      supportsVision: false,
      reasoningEffort: ReasoningEffort.LOW,
    } satisfies ModelCapabilities,
    openRouterOnly: false,
  },
};
