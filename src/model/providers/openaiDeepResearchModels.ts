// Local imports
import {
  DEFAULT_MODEL_CAPABILITIES,
  ModelCapabilities,
  ModelConfig,
  ModelProvider,
} from '@model/ModelConfig';

// Common capabilities for OpenAI reasoning models
const OPENAI_DEEP_RESEARCH_DEFAULT_CAPABILITIES: ModelCapabilities = {
  ...DEFAULT_MODEL_CAPABILITIES,
  supportsAutoPromptCaching: true,
  cacheDiscountFactor: 0.25,
  supportsReasoning: false,
  supportsIntermDevMsgs: false,
  supportsVision: true,
  supportsNativeWebSearch: true,
  supportsNativeMCPServer: true,
  supportsNativeCodeExecution: true,
  supportsNativePdf: true,
};

export const OPENAI_DEEP_RESEARCH_MODELS: Record<string, ModelConfig> = {
  'o3-deep-research': {
    name: 'o3-deep-research',
    fullName: 'o3-deep-research',
    openrouterFullName: 'openai/o3-deep-research',
    provider: ModelProvider.OPENAI,
    maxOutputTokens: 100000,
    contextWindow: 200000,
    inputPrice: 10,
    outputPrice: 40,
    capabilities: {
      ...OPENAI_DEEP_RESEARCH_DEFAULT_CAPABILITIES,
    },
    openRouterOnly: false,
  },
  'o4-mini-deep-research': {
    name: 'o4-mini-deep-research',
    fullName: 'o4-mini-deep-research',
    openrouterFullName: 'openai/o4-mini-deep-research',
    provider: ModelProvider.OPENAI,
    maxOutputTokens: 100000,
    contextWindow: 200000,
    inputPrice: 2,
    outputPrice: 8,
    capabilities: {
      ...OPENAI_DEEP_RESEARCH_DEFAULT_CAPABILITIES,
    },
    openRouterOnly: false,
  },
};
