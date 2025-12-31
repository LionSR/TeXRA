import {
  DEFAULT_MODEL_CAPABILITIES,
  ModelCapabilities,
  ModelConfig,
  ModelProvider,
} from '../ModelConfig';

/**
 * Default capabilities for OpenAI deep research models.
 * These models use the Responses API and only support native tools.
 *
 * Note: Function calling is disabled because deep research models
 * only support native tools (web_search, file_search, mcp, code_interpreter).
 */
const OPENAI_DEEP_RESEARCH_DEFAULT_CAPABILITIES: ModelCapabilities = {
  ...DEFAULT_MODEL_CAPABILITIES,
  supportsFunctionCalling: false,
  supportsAutoPromptCaching: true,
  cacheDiscountFactor: 0.25,
  supportsReasoning: true,
  supportsIntermDevMsgs: false,
  supportsVision: true,
  supportsNativeWebSearch: true,
  supportsNativeMCPServer: true,
  supportsNativeCodeExecution: true,
  supportsNativePdf: true,
};

/**
 * OpenAI deep research model configurations.
 * These models require the Responses API and are optimized for research tasks.
 */
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
    requiresResponsesAPI: true,
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
    requiresResponsesAPI: true,
  },
};
