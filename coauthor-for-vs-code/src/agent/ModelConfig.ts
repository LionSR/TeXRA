/**
 * Model configuration data structures
 */

/**
 * Default configuration values
 */
export const DEFAULT_CONTEXT_WINDOW = 128000;

/**
 * Default model capabilities
 */
export const DEFAULT_MODEL_CAPABILITIES: ModelCapabilities = {
  supportsPromptCaching: false,
  supportsAutoPromptCaching: false,
  supportsReasoning: false,
  supportsVision: true,
  supportsNativePdf: false,
  supportsAssistantPrefill: false,
  supportsPredictiveOutput: false,
  likesToAskForConfirmation: false,
};

/**
 * Model provider enum
 */
export enum ModelProvider {
  ANTHROPIC = 'anthropic',
  OPENAI = 'openai',
  GOOGLE = 'google',
  OTHERS = 'others',
}

/**
 * Model capabilities interface
 */
export interface ModelCapabilities {
  supportsPromptCaching: boolean;
  supportsAutoPromptCaching: boolean;
  supportsReasoning: boolean;
  supportsVision: boolean;
  supportsNativePdf: boolean;
  supportsAssistantPrefill: boolean;
  supportsPredictiveOutput: boolean;
  likesToAskForConfirmation: boolean;
}

/**
 * Model configuration interface
 */
export interface ModelConfig {
  name: string; // Short name (e.g., "sonnet++")
  fullName: string; // Full model name (e.g., "claude-3-5-sonnet-20241022")
  provider: ModelProvider; // The model provider (e.g., ANTHROPIC, OPENAI)
  maxOutputTokens: number;
  inputPrice: number;
  outputPrice: number;
  baseUrl?: string; // Optional base URL
  contextWindow: number;
  capabilities: ModelCapabilities;
  useOpenRouter: boolean; // Whether to use OpenRouter for this model
  openrouterFullName?: string; // Full model name for OpenRouter (e.g., "anthropic/claude-3-opus-20240229")
}
