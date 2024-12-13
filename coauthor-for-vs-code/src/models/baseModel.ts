/**
 * Enum for different model providers
 */
export enum ModelProvider {
  ANTHROPIC = 'anthropic',
  OPENAI = 'openai',
  GOOGLE = 'google',
  OPENROUTER = 'openrouter',
}

/**
 * Base interface for model configurations
 */
export interface ModelConfig {
  name: string; // Short name (e.g., "sonnet++")
  fullName: string; // Full model name (e.g., "claude-3-5-sonnet-20241022")
  provider: ModelProvider;
  maxTokens: number;
  inputPrice: number;
  outputPrice: number;
  contextWindow?: number; // defaults to 128000
  supportsPromptCaching?: boolean; // defaults to false
  supportsReasoning?: boolean; // defaults to false
  supportsVision?: boolean; // defaults to true
  supportsNativePdf?: boolean; // defaults to false
  supportsAssistantPrefill?: boolean; // defaults to false
  supportsPredictiveOutput?: boolean; // defaults to false
  likesToAskForConfirmation?: boolean; // defaults to false
  baseUrl?: string;
}

/**
 * Utility functions to check provider type
 */
export const isAnthropicProvider = (provider: ModelProvider): boolean =>
  provider === ModelProvider.ANTHROPIC;

export const isOpenAIProvider = (provider: ModelProvider): boolean =>
  provider === ModelProvider.OPENAI;

export const isGoogleProvider = (provider: ModelProvider): boolean =>
  provider === ModelProvider.GOOGLE;

export const isOpenRouterProvider = (provider: ModelProvider): boolean =>
  provider === ModelProvider.OPENROUTER;

export const isOpenAICompatible = (provider: ModelProvider): boolean =>
  isOpenAIProvider(provider) ||
  isOpenRouterProvider(provider) ||
  isGoogleProvider(provider);
