/**
 * Configuration types and constants for language model interactions and capabilities.
 * Single source of truth: llm-zoo package.
 */

// Re-export types and values from llm-zoo
export {
  ModelProvider,
  ReasoningEffort,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MODEL_CAPABILITIES,
} from 'llm-zoo';

export type { ModelConfig, ModelCapabilities } from 'llm-zoo';

// Re-export Zod v4 schemas from llm-zoo/schemas
export {
  ReasoningEffortSchema,
  ModelProviderSchema,
  ModelCapabilitiesSchema,
  ModelConfigSchema,
  ModelRegistrySchema,
} from 'llm-zoo/schemas';

// Type alias for registry
import type { ModelConfig } from 'llm-zoo';
export type ModelRegistry = Record<string, ModelConfig>;
