// Local imports
import {
  DEFAULT_MODEL_CAPABILITIES,
  ModelCapabilities,
  ModelConfig,
  ModelProvider,
  ReasoningEffort,
} from '../ModelConfig';

// Common capabilities for Google models
// Continuation: ModelHandlerGoogleGenAI inspects Google's FinishReason stop signals.
// When MAX_TOKENS triggers without emitting the closing tag we enqueue a follow-up
// request so tuning changes should preserve the native stop reasons returned by the API.
const GOOGLE_DEFAULT_CAPABILITIES: ModelCapabilities = {
  ...DEFAULT_MODEL_CAPABILITIES,
  cacheDiscountFactor: 0.25,
  supportsNativePdf: true,
  supportsVision: true,
  supportsNativeAudio: true,
  supportsNativeMCPServer: false, // Google doesn't have native MCP support
};

export const GOOGLE_MODELS: Record<string, ModelConfig> = {
  gemini25p: {
    name: 'gemini25p',
    fullName: 'gemini-2.5-pro',
    openrouterFullName: 'google/gemini-2.5-pro',
    provider: ModelProvider.GOOGLE,
    maxOutputTokens: 65536,
    contextWindow: 1048576,
    inputPrice: 1.25, // 2.5 for >200K
    outputPrice: 10.0, // 20 for >200K
    capabilities: {
      ...GOOGLE_DEFAULT_CAPABILITIES,
      supportsPromptCaching: true,
      supportsAutoPromptCaching: true,
      supportsReasoning: true,
      supportsReasoningEffort: false,
      supportsNativeCodeExecution: true,
      supportsNativeWebSearch: true,
      supportsNativeMCPServer: true,
    } satisfies ModelCapabilities,
    openRouterOnly: false,
  },
  gemini25f: {
    name: 'geminif',
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
      supportsNativeWebSearch: true,
      supportsNativeMCPServer: true,
    } satisfies ModelCapabilities,
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
      supportsNativeWebSearch: true,
      supportsNativeMCPServer: true,
    } satisfies ModelCapabilities,
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
      supportsNativeCodeExecution: false, // Lite doesn't support code execution
      supportsNativeWebSearch: false, // Lite doesn't support search grounding
    } satisfies ModelCapabilities,
    openRouterOnly: false,
  },
};
