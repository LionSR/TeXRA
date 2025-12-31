import {
  DEFAULT_MODEL_CAPABILITIES,
  ModelCapabilities,
  ModelConfig,
  ModelProvider,
  ReasoningEffort,
} from '../ModelConfig';

/**
 * Default capabilities for Google Gemini models.
 * Features native PDF, vision, and audio support with 75% cache cost savings.
 *
 * Note: Native web search is disabled because Google's content generation API
 * doesn't support combining googleSearch with functionDeclarations
 * (this is a Live API only feature).
 */
const GOOGLE_DEFAULT_CAPABILITIES: ModelCapabilities = {
  ...DEFAULT_MODEL_CAPABILITIES,
  cacheDiscountFactor: 0.25,
  supportsNativePdf: true,
  supportsVision: true,
  supportsNativeAudio: true,
  supportsNativeMCPServer: false,
  supportsNativeWebSearch: false,
};

/**
 * Google Gemini model configurations.
 * Includes Gemini 3.x and 2.5 Pro/Flash variants.
 */
export const GOOGLE_MODELS: Record<string, ModelConfig> = {
  gemini3p: {
    name: 'gemini3p',
    fullName: 'gemini-3-pro-preview',
    openrouterFullName: 'google/gemini-3-pro-preview',
    provider: ModelProvider.GOOGLE,
    maxOutputTokens: 65536,
    contextWindow: 1048576,
    inputPrice: 2.0,
    outputPrice: 12.0,
    capabilities: {
      ...GOOGLE_DEFAULT_CAPABILITIES,
      supportsPromptCaching: true,
      supportsAutoPromptCaching: true,
      supportsReasoning: true,
      supportsReasoningEffort: true,
      reasoningEffort: ReasoningEffort.HIGH,
      supportsNativeCodeExecution: true,
      supportsNativeMCPServer: true,
    },
    openRouterOnly: false,
  },
  gemini3f: {
    name: 'gemini3f',
    fullName: 'gemini-3-flash-preview',
    openrouterFullName: 'google/gemini-3-flash-preview',
    provider: ModelProvider.GOOGLE,
    maxOutputTokens: 65536,
    contextWindow: 1048576,
    inputPrice: 0.3,
    outputPrice: 2.5,
    capabilities: {
      ...GOOGLE_DEFAULT_CAPABILITIES,
      supportsPromptCaching: true,
      supportsAutoPromptCaching: true,
      supportsReasoning: true,
      supportsReasoningEffort: true,
      reasoningEffort: ReasoningEffort.HIGH,
      supportsNativeCodeExecution: true,
      supportsNativeMCPServer: true,
    },
    openRouterOnly: false,
  },
  gemini25p: {
    name: 'gemini25p',
    fullName: 'gemini-2.5-pro',
    openrouterFullName: 'google/gemini-2.5-pro',
    provider: ModelProvider.GOOGLE,
    maxOutputTokens: 65536,
    contextWindow: 1048576,
    inputPrice: 1.25,
    outputPrice: 10.0,
    capabilities: {
      ...GOOGLE_DEFAULT_CAPABILITIES,
      supportsPromptCaching: true,
      supportsAutoPromptCaching: true,
      supportsReasoning: true,
      supportsReasoningEffort: false,
      supportsNativeCodeExecution: true,
      supportsNativeMCPServer: true,
    },
    openRouterOnly: false,
  },
  gemini25f: {
    name: 'gemini25f',
    fullName: 'gemini-flash-latest',
    openrouterFullName: 'google/gemini-2.5-flash-preview-09-2025',
    provider: ModelProvider.GOOGLE,
    maxOutputTokens: 65536,
    contextWindow: 1048576,
    inputPrice: 0.3,
    outputPrice: 2.5,
    capabilities: {
      ...GOOGLE_DEFAULT_CAPABILITIES,
      supportsPromptCaching: true,
      supportsAutoPromptCaching: true,
      supportsReasoning: true,
      supportsReasoningEffort: false,
      supportsNativeCodeExecution: true,
      supportsNativeMCPServer: true,
    },
    openRouterOnly: false,
  },
  gemini25f0617: {
    name: 'gemini25f',
    fullName: 'gemini-2.5-flash',
    openrouterFullName: 'google/gemini-2.5-flash',
    provider: ModelProvider.GOOGLE,
    maxOutputTokens: 65536,
    contextWindow: 1048576,
    inputPrice: 0.3,
    outputPrice: 2.5,
    capabilities: {
      ...GOOGLE_DEFAULT_CAPABILITIES,
      supportsPromptCaching: true,
      supportsAutoPromptCaching: true,
      supportsReasoning: true,
      supportsReasoningEffort: false,
      supportsNativeCodeExecution: true,
      supportsNativeMCPServer: true,
    },
    openRouterOnly: false,
  },
  'gemini25f-': {
    name: 'gemini25f-',
    fullName: 'gemini-2.5-flash-lite-preview-09-2025',
    openrouterFullName: 'google/gemini-2.5-flash-lite-preview-09-2025',
    provider: ModelProvider.GOOGLE,
    maxOutputTokens: 32768,
    contextWindow: 65536,
    inputPrice: 0.1,
    outputPrice: 0.4,
    capabilities: {
      ...GOOGLE_DEFAULT_CAPABILITIES,
      supportsPromptCaching: true,
      supportsAutoPromptCaching: true,
      supportsReasoning: true,
      supportsReasoningEffort: false,
      supportsNativeCodeExecution: false,
    },
    openRouterOnly: false,
  },
};
