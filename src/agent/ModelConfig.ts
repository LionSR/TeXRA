/**
 * Configuration types and constants for language model interactions and capabilities.
 */

import { ToolConfig } from './ToolConfig';

/**
 * Default configuration values
 */
export const DEFAULT_CONTEXT_WINDOW = 128000;


export enum ReasoningEffort {
  HIGH = 'high',
  MEDIUM = 'medium',
  LOW = 'low',
  NONE = 'none',
}


/** Base model capabilities configuration with all features disabled by default. */
export const DEFAULT_MODEL_CAPABILITIES: ModelCapabilities = {
  supportsPromptCaching: false,
  supportsAutoPromptCaching: false,
  supportsReasoning: false,
  reasoningEffort: ReasoningEffort.NONE,
  supportsVision: true,
  supportsNativePdf: false,
  supportsAssistantPrefill: false,
  supportsPredictiveOutput: false,
  supportsTokenCounting: false,
  supportsSystemPrompt: true,
  supportsIntermDevMsgs: false,
};

/** Supported language model providers with their API identifiers. */
export enum ModelProvider {
  ANTHROPIC = 'anthropic',
  OPENAI = 'openai',
  GOOGLE = 'google',
  DEEPSEEK = 'deepseek',
  XAI = 'xai',
  OTHERS = 'others',
}

/** Feature flags defining model's supported capabilities and behaviors. */
export interface ModelCapabilities {
  supportsPromptCaching: boolean;
  supportsAutoPromptCaching: boolean;
  supportsReasoning: boolean;
  reasoningEffort: ReasoningEffort;
  supportsVision: boolean;
  supportsNativePdf: boolean;
  supportsAssistantPrefill: boolean;
  supportsPredictiveOutput: boolean;
  supportsTokenCounting: boolean;
  supportsSystemPrompt: boolean;
  supportsIntermDevMsgs: boolean;
}

/** Complete configuration for a language model instance. */
export interface ModelConfig {
  name: string; // Short name (e.g., "sonnet*")
  fullName: string; // Full model name (e.g., "claude-3-7-sonnet-20250219")
  provider: ModelProvider; // The model provider (e.g., ANTHROPIC, OPENAI)
  maxOutputTokens: number;
  inputPrice: number;
  outputPrice: number;
  contextWindow: number;
  capabilities: ModelCapabilities;
  openRouterOnly: boolean; // Whether this model is only available through OpenRouter
  openrouterFullName?: string; // Full model name for OpenRouter (e.g., "anthropic/claude-3-opus-20240229")
  toolConfig?: ToolConfig; // Reference to tool configuration
}
