/**
 * Zod schemas for runtime validation of model configurations.
 * @packageDocumentation
 */

import { z } from 'zod';

// ============================================================================
// Enums
// ============================================================================

export const ReasoningEffortSchema = z.enum(['xhigh', 'high', 'medium', 'low', 'none']);

export const ModelProviderSchema = z.enum([
  'anthropic',
  'openai',
  'google',
  'deepseek',
  'xai',
  'moonshot',
  'dashscope',
  'copilot',
  'others',
]);

// ============================================================================
// Capabilities
// ============================================================================

export const ModelCapabilitiesSchema = z.object({
  supportsFunctionCalling: z.boolean(),
  supportsNativeMCPServer: z.boolean(),
  supportsNativeWebSearch: z.boolean(),
  supportsNativeCodeExecution: z.boolean(),
  supportsPromptCaching: z.boolean(),
  supportsAutoPromptCaching: z.boolean(),
  cacheDiscountFactor: z.number().min(0).max(1),
  supportsReasoning: z.boolean(),
  supportsInterleavedThinking: z.boolean(),
  supportsReasoningEffort: z.boolean(),
  reasoningEffort: ReasoningEffortSchema,
  supportsVision: z.boolean(),
  supportsNativePdf: z.boolean(),
  supportsNativeAudio: z.boolean(),
  supportsAssistantPrefill: z.boolean(),
  supportsPredictiveOutput: z.boolean(),
  supportsTokenCounting: z.boolean(),
  supportsSystemPrompt: z.boolean(),
  supportsIntermDevMsgs: z.boolean(),
});

// ============================================================================
// Model Config
// ============================================================================

export const ModelConfigSchema = z.object({
  name: z.string(),
  fullName: z.string(),
  provider: ModelProviderSchema,
  maxOutputTokens: z.number().positive(),
  inputPrice: z.number().min(0),
  outputPrice: z.number().min(0),
  contextWindow: z.number().positive(),
  capabilities: ModelCapabilitiesSchema,
  openRouterOnly: z.boolean(),
  openrouterFullName: z.string().optional(),
  baseUrl: z.string().url().optional(),
  requiresResponsesAPI: z.boolean().optional(),
});

// ============================================================================
// Registry
// ============================================================================

export const ModelRegistrySchema = z.record(z.string(), ModelConfigSchema);

// ============================================================================
// Inferred Types (for reference)
// ============================================================================

export type ModelCapabilitiesZ = z.infer<typeof ModelCapabilitiesSchema>;
export type ModelConfigZ = z.infer<typeof ModelConfigSchema>;
export type ModelRegistryZ = z.infer<typeof ModelRegistrySchema>;
