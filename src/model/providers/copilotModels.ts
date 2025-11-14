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
    fullName: 'copilot-gpt-4o',
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
};
