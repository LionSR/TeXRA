import {
  DEFAULT_MODEL_CAPABILITIES,
  ModelCapabilities,
  ModelConfig,
  ModelProvider,
  ReasoningEffort,
} from '../ModelConfig';

// reansoning effort:
// For Anthropic models, maybe a good value:
// 1. The reasoning token allocation is capped at 32,000 tokens maximum and 1024 tokens minimum.
// 2. effort_ratio is 0.8 for high effort, 0.5 for medium effort, and 0.2 for low effort.

// Common capabilities for Anthropic models
const ANTHROPIC_DEFAULT_CAPABILITIES: ModelCapabilities = {
  ...DEFAULT_MODEL_CAPABILITIES,
  supportsPromptCaching: true,
  cacheDiscountFactor: 0.1,
  supportsTokenCounting: true,
  supportsNativePdf: true,
};

export const ANTHROPIC_MODELS: Record<string, ModelConfig> = {
  opus4T: {
    name: 'opus4T',
    fullName: 'claude-opus-4-20250514',
    openrouterFullName: 'anthropic/claude-opus-4:thinking',
    provider: ModelProvider.ANTHROPIC,
    maxOutputTokens: 21333, // Using extended output with beta header; if >21333, then we need streaming
    contextWindow: 200000,
    inputPrice: 15.0,
    outputPrice: 75.0,
    capabilities: {
      ...ANTHROPIC_DEFAULT_CAPABILITIES,
      supportsAssistantPrefill: false,
      supportsReasoning: true,
    } satisfies ModelCapabilities,
    openRouterOnly: false,
  },
  opus4: {
    name: 'opus4',
    fullName: 'claude-opus-4-20250514',
    openrouterFullName: 'anthropic/claude-opus-4',
    provider: ModelProvider.ANTHROPIC,
    maxOutputTokens: 21333, // Using extended output with beta header; if >21333, then we need streaming
    contextWindow: 200000,
    inputPrice: 15.0,
    outputPrice: 75.0,
    capabilities: {
      ...ANTHROPIC_DEFAULT_CAPABILITIES,
      supportsAssistantPrefill: true,
      supportsReasoning: false,
    } satisfies ModelCapabilities,
    openRouterOnly: false,
  },
  sonnet4T: {
    name: 'sonnet4T',
    fullName: 'claude-sonnet-4-20250514',
    openrouterFullName: 'anthropic/claude-sonnet-4:thinking',
    provider: ModelProvider.ANTHROPIC,
    maxOutputTokens: 21333, // Using extended output with beta header; if >21333, then we need streaming
    contextWindow: 200000,
    inputPrice: 5.0,
    outputPrice: 25.0,
    capabilities: {
      ...ANTHROPIC_DEFAULT_CAPABILITIES,
      supportsAssistantPrefill: false,
      supportsReasoning: true,
    } satisfies ModelCapabilities,
    openRouterOnly: false,
  },
  sonnet4: {
    name: 'sonnet4',
    fullName: 'claude-sonnet-4-20250514',
    openrouterFullName: 'anthropic/claude-sonnet-4',
    provider: ModelProvider.ANTHROPIC,
    maxOutputTokens: 21333, // Using extended output with beta header; if >21333, then we need streaming
    contextWindow: 200000,
    inputPrice: 3.0,
    outputPrice: 15.0,
    capabilities: {
      ...ANTHROPIC_DEFAULT_CAPABILITIES,
      supportsAssistantPrefill: true,
      supportsReasoning: false,
    } satisfies ModelCapabilities,
    openRouterOnly: false,
  },
  sonnet37T: {
    name: 'sonnet37T',
    fullName: 'claude-3-7-sonnet-20250219',
    openrouterFullName: 'anthropic/claude-3.7-sonnet:thinking',
    provider: ModelProvider.ANTHROPIC,
    maxOutputTokens: 21333, // Using extended output with beta header; if >21333, then we need streaming
    contextWindow: 200000,
    inputPrice: 3.0,
    outputPrice: 15.0,
    capabilities: {
      ...ANTHROPIC_DEFAULT_CAPABILITIES,
      supportsAssistantPrefill: false,
      supportsReasoning: true,
    } satisfies ModelCapabilities,
    openRouterOnly: false,
  },
  sonnet37: {
    name: 'sonnet37',
    fullName: 'claude-3-7-sonnet-20250219',
    openrouterFullName: 'anthropic/claude-3.7-sonnet',
    provider: ModelProvider.ANTHROPIC,
    maxOutputTokens: 21333, // Using extended output with beta header; if >21333, then we need streaming
    contextWindow: 200000,
    inputPrice: 3.0,
    outputPrice: 15.0,
    capabilities: {
      ...ANTHROPIC_DEFAULT_CAPABILITIES,
      supportsAssistantPrefill: true,
      supportsReasoning: false,
    } satisfies ModelCapabilities,
    openRouterOnly: false,
  },
  opus3: {
    name: 'opus3',
    fullName: 'claude-3-opus-20240229',
    openrouterFullName: 'anthropic/claude-3-opus:beta',
    provider: ModelProvider.ANTHROPIC,
    maxOutputTokens: 4096,
    contextWindow: 200000,
    inputPrice: 15.0,
    outputPrice: 75.0,
    capabilities: {
      ...ANTHROPIC_DEFAULT_CAPABILITIES,
      supportsAssistantPrefill: true,
      supportsReasoning: false,
    } satisfies ModelCapabilities,
    openRouterOnly: false,
  },
  sonnet36: {
    name: 'sonnet36',
    fullName: 'claude-3-5-sonnet-20241022',
    openrouterFullName: 'anthropic/claude-3.5-sonnet:beta',
    provider: ModelProvider.ANTHROPIC,
    maxOutputTokens: 8192,
    contextWindow: 200000,
    inputPrice: 3.0,
    outputPrice: 15.0,
    capabilities: {
      ...ANTHROPIC_DEFAULT_CAPABILITIES,
      supportsAssistantPrefill: true,
      supportsReasoning: false,
    } satisfies ModelCapabilities,
    openRouterOnly: false,
  },
  sonnet35: {
    name: 'sonnet35',
    fullName: 'claude-3-5-sonnet-20240620',
    openrouterFullName: 'anthropic/claude-3.5-sonnet-20240620:beta',
    provider: ModelProvider.ANTHROPIC,
    maxOutputTokens: 8192,
    contextWindow: 200000,
    inputPrice: 3.0,
    outputPrice: 15.0,
    capabilities: {
      ...ANTHROPIC_DEFAULT_CAPABILITIES,
      supportsAssistantPrefill: true,
      supportsReasoning: false,
    } satisfies ModelCapabilities,
    openRouterOnly: false,
  },
  sonnet3: {
    name: 'sonnet3',
    fullName: 'claude-3-sonnet-20240229',
    openrouterFullName: 'anthropic/claude-3.5-sonnet-20240229:beta',
    provider: ModelProvider.ANTHROPIC,
    maxOutputTokens: 8192,
    contextWindow: 200000,
    inputPrice: 3.0,
    outputPrice: 15.0,
    capabilities: {
      ...ANTHROPIC_DEFAULT_CAPABILITIES,
      supportsAssistantPrefill: true,
      supportsReasoning: false,
    } satisfies ModelCapabilities,
    openRouterOnly: false,
  },
  haiku35: {
    name: 'haiku35',
    fullName: 'claude-3-5-haiku-20241022',
    openrouterFullName: 'anthropic/claude-3.5-haiku:beta',
    provider: ModelProvider.ANTHROPIC,
    maxOutputTokens: 8192,
    contextWindow: 200000,
    inputPrice: 0.8,
    outputPrice: 4.0,
    capabilities: {
      ...ANTHROPIC_DEFAULT_CAPABILITIES,
      supportsAssistantPrefill: true,
      supportsReasoning: false,
      supportsVision: true,
    } satisfies ModelCapabilities,
    openRouterOnly: false,
  },
  haiku3: {
    name: 'haiku3',
    fullName: 'claude-3-haiku-20240307',
    openrouterFullName: 'anthropic/claude-3.5-haiku-20240307:beta',
    provider: ModelProvider.ANTHROPIC,
    maxOutputTokens: 8192,
    contextWindow: 200000,
    inputPrice: 0.25,
    outputPrice: 1.25,
    capabilities: {
      ...ANTHROPIC_DEFAULT_CAPABILITIES,
      supportsAssistantPrefill: true,
      supportsReasoning: false,
    } satisfies ModelCapabilities,
    openRouterOnly: false,
  },
};
