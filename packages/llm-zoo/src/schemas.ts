/**
 * Zod v4 validation schemas for llm-zoo types.
 * Requires zod ^4.0.0 as peer dependency.
 *
 * @example
 * ```typescript
 * import { ModelConfigSchema } from 'llm-zoo/schemas';
 *
 * const result = ModelConfigSchema.safeParse(myConfig);
 * if (!result.success) {
 *   console.error(result.error);
 * }
 * ```
 */

import { z } from 'zod';
import { ModelProvider, ReasoningEffort } from './ModelConfig';

// ============================================================================
// Zod v4 Schemas
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
  name: z.string(),
  fullName: z.string(),
  provider: ModelProviderSchema,
  maxOutputTokens: z.number(),
  inputPrice: z.number(),
  outputPrice: z.number(),
  contextWindow: z.number(),
  capabilities: ModelCapabilitiesSchema,
  openRouterOnly: z.boolean(),
  openrouterFullName: z.string().optional(),
  baseUrl: z.string().optional(),
  requiresResponsesAPI: z.boolean().optional(),
});

/** Registry of all model configurations. */
export const ModelRegistrySchema = z.record(z.string(), ModelConfigSchema);

// Export inferred types for convenience
export type ModelCapabilitiesSchemaType = z.infer<typeof ModelCapabilitiesSchema>;
export type ModelConfigSchemaType = z.infer<typeof ModelConfigSchema>;
export type ModelRegistrySchemaType = z.infer<typeof ModelRegistrySchema>;
