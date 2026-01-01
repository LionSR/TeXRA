/**
 * Configuration types and constants for language model interactions and capabilities.
 * Types and runtime values from llm-zoo, Zod schemas local (Zod v4).
 */

import { z } from 'zod';

// Re-export types and values from llm-zoo
export {
  ModelProvider,
  ReasoningEffort,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MODEL_CAPABILITIES,
} from 'llm-zoo';

export type { ModelConfig, ModelCapabilities } from 'llm-zoo';

// Import for local use
import { ModelProvider, ReasoningEffort } from 'llm-zoo';
import type { ModelConfig, ModelCapabilities } from 'llm-zoo';

// ============================================================================
// Zod v4 Schemas - Local (avoids moduleResolution issues with subpath imports)
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

// Type alias for registry
export type ModelRegistry = Record<string, ModelConfig>;

// ============================================================================
// Compile-time assertions - ensure schemas stay synchronized with llm-zoo types
// ============================================================================

type SchemaModelConfig = z.infer<typeof ModelConfigSchema>;
type SchemaModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;

// These will fail at compile time if local schemas diverge from llm-zoo types
const _assertModelConfig: SchemaModelConfig = {} as ModelConfig;
const _assertModelCapabilities: SchemaModelCapabilities =
  {} as ModelCapabilities;

// Suppress unused variable warnings
void _assertModelConfig;
void _assertModelCapabilities;
