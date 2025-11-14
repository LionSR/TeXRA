// Local imports
import {
  DEFAULT_MODEL_CAPABILITIES,
  ModelCapabilities,
  ModelConfig,
  ModelProvider,
  ReasoningEffort,
} from '@model/ModelConfig';

// Common capabilities for xAI models
const XAI_DEFAULT_CAPABILITIES: ModelCapabilities = {
  ...DEFAULT_MODEL_CAPABILITIES,
  supportsVision: false,
};

export const XAI_MODELS: Record<string, ModelConfig> = {
  grok4: {
    name: 'grok4',
    fullName: 'grok-4-0709',
    openrouterFullName: 'x-ai/grok-4-0709',
    provider: ModelProvider.XAI,
    maxOutputTokens: 128000, // Maximum 256000 but we should consider the input as well.
    contextWindow: 256000,
    inputPrice: 3.0,
    outputPrice: 15.0,
    capabilities: {
      ...XAI_DEFAULT_CAPABILITIES,
      supportsReasoning: true,
      supportsReasoningEffort: false,
    } satisfies ModelCapabilities,
    openRouterOnly: false,
  },
  grok3: {
    name: 'grok3',
    fullName: 'grok-3-beta',
    openrouterFullName: 'x-ai/grok-3',
    provider: ModelProvider.XAI,
    maxOutputTokens: 131072,
    contextWindow: 131072,
    inputPrice: 3.0,
    outputPrice: 15.0,
    capabilities: {
      ...XAI_DEFAULT_CAPABILITIES,
      supportsReasoning: false,
      supportsReasoningEffort: false,
    } satisfies ModelCapabilities,
    openRouterOnly: false,
  },
  'grok3-': {
    name: 'grok3-',
    fullName: 'grok-3-mini-beta',
    openrouterFullName: 'x-ai/grok-3-mini-beta',
    provider: ModelProvider.XAI,
    maxOutputTokens: 131072,
    contextWindow: 131072,
    inputPrice: 0.3,
    outputPrice: 0.5,
    capabilities: {
      ...XAI_DEFAULT_CAPABILITIES,
      supportsReasoning: true,
      supportsReasoningEffort: true,
      reasoningEffort: ReasoningEffort.LOW,
    } satisfies ModelCapabilities,
    openRouterOnly: false,
  },
  grok2: {
    name: 'grok2',
    fullName: 'grok-2-1212',
    openrouterFullName: 'grok-ai/grok-2-1212',
    provider: ModelProvider.XAI,
    maxOutputTokens: 131072,
    contextWindow: 131072,
    inputPrice: 2.0,
    outputPrice: 10.0,
    capabilities: XAI_DEFAULT_CAPABILITIES satisfies ModelCapabilities,
    openRouterOnly: false,
  },
  grok2v: {
    name: 'grok2v',
    fullName: 'grok-2-1212-vision',
    openrouterFullName: 'grok-ai/grok-2-1212-vision',
    provider: ModelProvider.XAI,
    maxOutputTokens: 32768,
    contextWindow: 32768,
    inputPrice: 2.0,
    outputPrice: 10.0,
    capabilities: {
      ...XAI_DEFAULT_CAPABILITIES,
      supportsVision: true,
    } satisfies ModelCapabilities,
    openRouterOnly: false,
  },
};
