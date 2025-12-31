/**
 * Configuration types and constants for language model interactions and capabilities.
 * Uses Zod schemas as the single source of truth.
 */

import { z } from 'zod';

// ============================================================================
// Default Values
// ============================================================================

export const DEFAULT_CONTEXT_WINDOW = 128000;

// ============================================================================
// Enums (defined first for use in schemas)
// ============================================================================

export enum ReasoningEffort {
  XHIGH = 'xhigh',
  HIGH = 'high',
  MEDIUM = 'medium',
  LOW = 'low',
  NONE = 'none',
}

export enum ModelProvider {
  ANTHROPIC = 'anthropic',
  OPENAI = 'openai',
  GOOGLE = 'google',
  DEEPSEEK = 'deepseek',
  XAI = 'xai',
  MOONSHOT = 'moonshot',
  DASHSCOPE = 'dashscope',
  COPILOT = 'copilot',
  OTHERS = 'others',
}

// ============================================================================
// Zod Schemas - Single Source of Truth
// ============================================================================

export const ReasoningEffortSchema = z.nativeEnum(ReasoningEffort);

export const ModelProviderSchema = z.nativeEnum(ModelProvider);

/** Feature flags defining model's supported capabilities and behaviors. */
export const ModelCapabilitiesSchema = z.object({
  supportsFunctionCalling: z.boolean(),
  supportsNativeMCPServer: z.boolean(),
  supportsNativeWebSearch: z.boolean(),
  supportsNativeCodeExecution: z.boolean(),
  supportsPromptCaching: z.boolean(),
  supportsAutoPromptCaching: z.boolean(),
  cacheDiscountFactor: z.number(),
  supportsReasoning: z.boolean(),
  supportsInterleavedThinking: z.boolean(),
  reasoningEffort: ReasoningEffortSchema,
  supportsVision: z.boolean(),
  supportsNativePdf: z.boolean(),
  supportsAssistantPrefill: z.boolean(),
  supportsPredictiveOutput: z.boolean(),
  supportsTokenCounting: z.boolean(),
  supportsSystemPrompt: z.boolean(),
  supportsIntermDevMsgs: z.boolean(),
  supportsReasoningEffort: z.boolean(),
  supportsNativeAudio: z.boolean(),
});

/** Complete configuration for a language model instance. */
export const ModelConfigSchema = z.object({
  name: z.string(), // Short name (e.g., "sonnet4T")
  fullName: z.string(), // Full model name (e.g., "claude-3-7-sonnet-20250219")
  provider: ModelProviderSchema,
  maxOutputTokens: z.number(),
  inputPrice: z.number(),
  outputPrice: z.number(),
  contextWindow: z.number(),
  capabilities: ModelCapabilitiesSchema,
  openRouterOnly: z.boolean(), // Whether this model is only available through OpenRouter
  openrouterFullName: z.string().optional(), // Full model name for OpenRouter
  baseUrl: z.string().optional(), // Custom base URL for this specific model
  requiresResponsesAPI: z.boolean().optional(), // Whether this model requires OpenAI Responses API
});

/** Registry of all model configurations. */
export const ModelRegistrySchema = z.record(z.string(), ModelConfigSchema);

// ============================================================================
// Types - Derived from Schemas
// ============================================================================

export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type ModelRegistry = z.infer<typeof ModelRegistrySchema>;

// ============================================================================
// Default Values
// ============================================================================

/** Base model capabilities configuration with sensible defaults. */
export const DEFAULT_MODEL_CAPABILITIES: ModelCapabilities = {
  supportsFunctionCalling: true,
  supportsNativeMCPServer: false,
  supportsNativeWebSearch: false,
  supportsNativeCodeExecution: false,
  supportsPromptCaching: false,
  supportsAutoPromptCaching: false,
  cacheDiscountFactor: 1.0,
  supportsReasoning: false,
  supportsInterleavedThinking: false,
  reasoningEffort: ReasoningEffort.NONE,
  supportsVision: true,
  supportsNativePdf: false,
  supportsAssistantPrefill: false,
  supportsPredictiveOutput: false,
  supportsTokenCounting: false,
  supportsSystemPrompt: true,
  supportsIntermDevMsgs: false,
  supportsReasoningEffort: false,
  supportsNativeAudio: false,
};
